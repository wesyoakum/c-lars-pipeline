// functions/settings/wfm-import/commit.js
//
// POST /settings/wfm-import/commit
// Body: { samples: { clients, leads, quotes, jobs, staff } }
//
// Takes a list of WFM records the user has reviewed and writes them
// into Pipeline. Idempotent on (external_source, external_id) — re-
// running with the same WFM UUIDs updates the existing rows instead
// of duplicating.
//
// Pipeline UUIDs are generated server-side; the WFM UUID lives in
// `external_id` only. wfm_payload stores the full WFM record for
// fidelity.
//
// Sequencing (FK integrity):
//   1. Staff   — enrich users, build email→id + WFM-UUID→id maps
//   2. Clients — INSERT/UPDATE accounts; map WFM-UUID → Pipeline-id
//   3. Contacts (nested in client detail) — INSERT/UPDATE; FK to account
//   4. Leads   — INSERT/UPDATE opportunities; FK to account/contact/user
//   5. Quotes  — INSERT/UPDATE quotes; FK to opportunity
//   6. Jobs    — INSERT/UPDATE opportunities (won/post-win stages),
//                + INSERT/UPDATE jobs row when ClientOrderNumber set
//
// Number allocation: WFM-imported records get OPP-WFM-NNNN /
// Q-WFM-NNNN / JOB-WFM-NNNN numbers — separate from the
// human-typed OPP-2026-NNNN sequence so the two namespaces don't
// fight.

import { hasRole } from '../../lib/auth.js';
import { one, run, all } from '../../lib/db.js';
import { apiGet, recordList } from '../../lib/wfm-client.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function nowIso() { return new Date().toISOString(); }
function uuid()   { return crypto.randomUUID(); }
function yesNo(v) { return /^(yes|true|1)$/i.test(String(v || '').trim()) ? 1 : 0; }
function n(v)     { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; }
function s(v)     { return v == null ? '' : String(v); }

function joinAddress(c) {
  const parts = [
    c.Address,
    [c.City, c.Region].filter(Boolean).join(' '),
    [c.PostCode, c.Country].filter(Boolean).join(' '),
  ].filter((p) => p && String(p).trim());
  return parts.join('\n').trim();
}
function joinPostalAddress(c) {
  const parts = [
    c.PostalAddress,
    [c.PostalCity, c.PostalRegion].filter(Boolean).join(' '),
    [c.PostalPostCode, c.PostalCountry].filter(Boolean).join(' '),
  ].filter((p) => p && String(p).trim());
  return parts.join('\n').trim();
}
function splitName(fullName) {
  const trimmed = String(fullName || '').trim();
  if (!trimmed) return { first_name: '', last_name: '' };
  const sp = trimmed.indexOf(' ');
  if (sp < 0) return { first_name: trimmed, last_name: '' };
  return { first_name: trimmed.slice(0, sp), last_name: trimmed.slice(sp + 1).trim() };
}

// ---------- Stage / category mappings (per docs/wfm-mapping.md §6) ----------

const LEAD_CATEGORY_TO_STAGE = {
  '1 Identified':  'lead',
  '2 Qualifying':  'rfq_received',
  '3 Opportunity': 'quote_drafted',
  '4 Quoted':      'quote_submitted',
  '5 Won':         'won',
  '6 Lost':        'lost',
};

const CATEGORY_NAME_TO_TYPE = {
  'NEW EQUIPMENT':    { type: 'eps',     note: null },
  'SPARES':           { type: 'spares',  note: null },
  'REFURBISHMENT':    { type: 'refurb',  note: null },
  'SERVICE':          { type: 'service', note: null },
  'SUPPLIES':         { type: 'spares',  note: 'SUPPLIES' },
  'WARRANTY':         { type: 'service', note: 'WARRANTY' },
  'CYLINDERS':        { type: 'spares',  note: 'CYLINDERS' },
  'REFURB CYLINDERS': { type: 'refurb',  note: 'REFURB CYLINDERS' },
};

const JOB_STATE_TO_STAGE = {
  PLANNED:    'won',
  PRODUCTION: 'job_in_progress',
  COMPLETED:  'completed',
  CANCELLED:  'abandoned',
};

const JOB_STATE_TO_JOBS_STATUS = {
  PLANNED: 'created',
  PRODUCTION: 'handed_off',
  COMPLETED: 'handed_off',
  CANCELLED: 'cancelled',
};

const QUOTE_STATE_TO_STATUS = {
  Draft:    'draft',
  Issued:   'submitted',
  Accepted: 'accepted',
  Declined: 'rejected',
  Archived: 'expired',
};

// ---------- Number allocation ----------

async function allocateNumber(env, prefix) {
  // prefix is 'OPP-WFM' / 'Q-WFM' / 'JOB-WFM'. Pads to 4 digits.
  // Reads + increments via the sequences table (atomic per row).
  const scope = prefix;
  let next;
  const existing = await one(env.DB, 'SELECT next_value FROM sequences WHERE scope = ?', [scope]);
  if (existing) {
    next = existing.next_value;
    await run(env.DB, 'UPDATE sequences SET next_value = next_value + 1 WHERE scope = ?', [scope]);
  } else {
    next = 1;
    await run(env.DB, 'INSERT INTO sequences (scope, next_value) VALUES (?, ?)', [scope, 2]);
  }
  return `${prefix}-${String(next).padStart(4, '0')}`;
}

// ---------- Per-entity upserts ----------

async function upsertAccount(env, c) {
  // 1) Already WFM-imported? Idempotent update.
  let existing = await one(env.DB,
    'SELECT id FROM accounts WHERE external_source = ? AND external_id = ?',
    ['wfm', c.UUID]);

  // 2) Smart-match against an existing account with the same name
  //    (case-insensitive, trimmed). Excludes accounts that are
  //    already wfm-imported (those have a different WFM UUID and
  //    represent a different WFM record). Includes Pipeline-native
  //    accounts AND accounts imported from other systems — for the
  //    user's case, "ROVOP Inc" might have been seeded from a prior
  //    Xero import, so just `external_id IS NULL` would miss it.
  let claimed = false;
  if (!existing && s(c.Name)) {
    const match = await one(env.DB,
      `SELECT id, external_source, external_id FROM accounts
        WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))
          AND (external_source IS NULL OR external_source != 'wfm')
        LIMIT 1`,
      [s(c.Name)]);
    if (match) { existing = match; claimed = true; }
  }

  const ts = nowIso();
  const cols = {
    name:                 s(c.Name),
    email:                s(c.Email),
    phone:                s(c.Phone),
    fax:                  s(c.Fax),
    website:              s(c.Website),
    address_billing:      joinAddress(c),
    address_physical:     joinPostalAddress(c),
    external_url:         s(c.WebURL),
    account_manager_name: s(c.AccountManager),
    referral_source:      s(c.ReferralSource),
    export_code:          s(c.ExportCode),
    is_archived:          yesNo(c.IsArchived),
    is_prospect:          yesNo(c.IsProspect),
    is_deleted:           yesNo(c.IsDeleted),
    wfm_payload:          JSON.stringify(c),
    updated_at:           ts,
  };

  if (existing) {
    // For claims, we also need to write the external_source/external_id
    // so future re-imports of this WFM record find the row by UUID.
    const writeCols = claimed
      ? { external_source: 'wfm', external_id: c.UUID, ...cols }
      : cols;
    const setClause = Object.keys(writeCols).map((k) => k + ' = ?').join(', ');
    await run(env.DB,
      'UPDATE accounts SET ' + setClause + ' WHERE id = ?',
      [...Object.values(writeCols), existing.id]);
    return { id: existing.id, action: claimed ? 'claimed' : 'updated' };
  } else {
    const id = uuid();
    await run(env.DB,
      `INSERT INTO accounts
         (id, external_source, external_id,
          name, email, phone, fax, website,
          address_billing, address_physical, external_url,
          account_manager_name, referral_source, export_code,
          is_archived, is_prospect, is_deleted, wfm_payload,
          created_at, updated_at)
       VALUES (?, 'wfm', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, c.UUID,
       cols.name, cols.email, cols.phone, cols.fax, cols.website,
       cols.address_billing, cols.address_physical, cols.external_url,
       cols.account_manager_name, cols.referral_source, cols.export_code,
       cols.is_archived, cols.is_prospect, cols.is_deleted, cols.wfm_payload,
       ts, ts]);
    return { id, action: 'created' };
  }
}

async function upsertContact(env, ct, accountId) {
  // 1) Already WFM-imported?
  let existing = await one(env.DB,
    'SELECT id FROM contacts WHERE external_source = ? AND external_id = ?',
    ['wfm', ct.UUID]);

  // 2) Smart-match against an existing contact on the same account.
  //    Match by email first (most reliable); if no email, fall back
  //    to first + last name. Excludes contacts that are already
  //    wfm-imported (different WFM record); includes Pipeline-native
  //    AND non-WFM-imported contacts.
  let claimed = false;
  const split = splitName(ct.Name);
  if (!existing) {
    if (s(ct.Email)) {
      existing = await one(env.DB,
        `SELECT id FROM contacts
          WHERE account_id = ?
            AND (external_source IS NULL OR external_source != 'wfm')
            AND LOWER(TRIM(email)) = LOWER(TRIM(?))
          LIMIT 1`,
        [accountId, s(ct.Email)]);
      if (existing) claimed = true;
    }
    if (!existing && split.first_name && split.last_name) {
      existing = await one(env.DB,
        `SELECT id FROM contacts
          WHERE account_id = ?
            AND (external_source IS NULL OR external_source != 'wfm')
            AND LOWER(TRIM(first_name)) = LOWER(TRIM(?))
            AND LOWER(TRIM(last_name)) = LOWER(TRIM(?))
          LIMIT 1`,
        [accountId, split.first_name, split.last_name]);
      if (existing) claimed = true;
    }
  }

  const ts = nowIso();
  const cols = {
    account_id:  accountId,
    first_name:  split.first_name,
    last_name:   split.last_name,
    title:       s(ct.Position),
    email:       s(ct.Email),
    phone:       s(ct.Phone),
    mobile:      s(ct.Mobile),
    is_primary:  yesNo(ct.IsPrimary),
    salutation:  s(ct.Salutation),
    addressee:   s(ct.Addressee),
    wfm_payload: JSON.stringify(ct),
    updated_at:  ts,
  };

  if (existing) {
    const writeCols = claimed
      ? { external_source: 'wfm', external_id: ct.UUID, ...cols }
      : cols;
    const setClause = Object.keys(writeCols).map((k) => k + ' = ?').join(', ');
    await run(env.DB,
      'UPDATE contacts SET ' + setClause + ' WHERE id = ?',
      [...Object.values(writeCols), existing.id]);
    return { id: existing.id, action: claimed ? 'claimed' : 'updated' };
  } else {
    const id = uuid();
    await run(env.DB,
      `INSERT INTO contacts
         (id, external_source, external_id, account_id,
          first_name, last_name, title, email, phone, mobile,
          is_primary, salutation, addressee, wfm_payload,
          created_at, updated_at)
       VALUES (?, 'wfm', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, ct.UUID, accountId,
       cols.first_name, cols.last_name, cols.title, cols.email, cols.phone, cols.mobile,
       cols.is_primary, cols.salutation, cols.addressee, cols.wfm_payload,
       ts, ts]);
    return { id, action: 'created' };
  }
}

async function upsertOpportunityFromLead(env, lead, accountId, contactId, ownerUserId) {
  const existing = await one(env.DB,
    'SELECT id, number FROM opportunities WHERE external_source = ? AND external_id = ?',
    ['wfm-lead', lead.UUID]);

  let stage = LEAD_CATEGORY_TO_STAGE[lead.Category] || 'lead';
  if (lead.State === 'Won')  stage = 'won';
  if (lead.State === 'Lost') stage = 'lost';

  const ts = nowIso();
  const cols = {
    title:               s(lead.Name),
    description:         s(lead.Description),
    transaction_type:    'spares',                         // sample default; can be overridden later
    stage,
    estimated_value_usd: n(lead.EstimatedValue),
    actual_close_date:   s(lead.DateWonLost),
    account_id:          accountId,
    primary_contact_id:  contactId || null,
    owner_user_id:       ownerUserId || null,
    wfm_category:        s(lead.Category),
    wfm_type:            '',
    wfm_payload:         JSON.stringify(lead),
    updated_at:          ts,
  };

  if (existing) {
    const setClause = Object.keys(cols).map((k) => `${k} = ?`).join(', ');
    await run(env.DB,
      `UPDATE opportunities SET ${setClause} WHERE id = ?`,
      [...Object.values(cols), existing.id]);
    return { id: existing.id, number: existing.number, action: 'updated' };
  } else {
    const id = uuid();
    const number = await allocateNumber(env, 'OPP-WFM');
    await run(env.DB,
      `INSERT INTO opportunities
         (id, number, external_source, external_id,
          account_id, primary_contact_id, owner_user_id,
          title, description, transaction_type, stage,
          estimated_value_usd, actual_close_date,
          wfm_category, wfm_type, wfm_payload,
          stage_entered_at, created_at, updated_at)
       VALUES (?, ?, 'wfm-lead', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, number, lead.UUID,
       accountId, contactId || null, ownerUserId || null,
       cols.title, cols.description, cols.transaction_type, cols.stage,
       cols.estimated_value_usd, cols.actual_close_date,
       cols.wfm_category, cols.wfm_type, cols.wfm_payload,
       ts, ts, ts]);
    return { id, number, action: 'created' };
  }
}

async function upsertOpportunityFromJob(env, job, accountId, ownerUserId) {
  const existing = await one(env.DB,
    'SELECT id, number FROM opportunities WHERE external_source = ? AND external_id = ?',
    ['wfm-job', job.UUID]);

  const typeMap = CATEGORY_NAME_TO_TYPE[job.Type] || { type: 'spares', note: null };
  const stage   = JOB_STATE_TO_STAGE[job.State] || 'won';
  const noteLine = typeMap.note ? `[WFM] Original category: ${typeMap.note} (mapped → ${typeMap.type}).` : '';

  const ts = nowIso();
  const cols = {
    title:               s(job.Name),
    description:         s(job.Description),
    transaction_type:    typeMap.type,
    stage,
    estimated_value_usd: n(job.Budget),
    actual_close_date:   s(job.StartDate),
    account_id:          accountId,
    owner_user_id:       ownerUserId || null,
    wfm_category:        s(job.Type),
    wfm_type:            s(job.Type),
    external_url:        s(job.WebURL),
    notes_internal:      noteLine,
    wfm_payload:         JSON.stringify(job),
    updated_at:          ts,
  };

  if (existing) {
    const setClause = Object.keys(cols).map((k) => `${k} = ?`).join(', ');
    await run(env.DB,
      `UPDATE opportunities SET ${setClause} WHERE id = ?`,
      [...Object.values(cols), existing.id]);
    return { id: existing.id, number: existing.number, action: 'updated' };
  } else {
    const id = uuid();
    const number = await allocateNumber(env, 'OPP-WFM');
    await run(env.DB,
      `INSERT INTO opportunities
         (id, number, external_source, external_id,
          account_id, owner_user_id,
          title, description, transaction_type, stage,
          estimated_value_usd, actual_close_date,
          wfm_category, wfm_type, external_url, notes_internal, wfm_payload,
          stage_entered_at, created_at, updated_at)
       VALUES (?, ?, 'wfm-job', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, number, job.UUID,
       accountId, ownerUserId || null,
       cols.title, cols.description, cols.transaction_type, cols.stage,
       cols.estimated_value_usd, cols.actual_close_date,
       cols.wfm_category, cols.wfm_type, cols.external_url, cols.notes_internal, cols.wfm_payload,
       ts, ts, ts]);
    return { id, number, action: 'created' };
  }
}

async function upsertQuote(env, q, opportunityId) {
  const existing = await one(env.DB,
    'SELECT id, number FROM quotes WHERE external_source = ? AND external_id = ?',
    ['wfm', q.UUID]);

  const ts = nowIso();
  const cols = {
    opportunity_id:      opportunityId,
    title:               s(q.Name),
    description:         s(q.Description),
    quote_type:          'spares',                         // default; usually overridden by parent opp's transaction_type
    status:              QUOTE_STATE_TO_STATUS[q.State] || 'draft',
    valid_until:         s(q.ValidDate),
    subtotal_price:      n(q.Amount),
    tax_amount:          n(q.AmountTax),
    total_price:         n(q.AmountIncludingTax),
    notes_customer:      s(q.OptionExplanation),
    wfm_number:          s(q.ID),
    wfm_type:            s(q.Type),
    wfm_state:           s(q.State),
    wfm_budget:          s(q.Budget),
    wfm_payload:         JSON.stringify(q),
    updated_at:          ts,
  };

  if (existing) {
    const setClause = Object.keys(cols).map((k) => `${k} = ?`).join(', ');
    await run(env.DB,
      `UPDATE quotes SET ${setClause} WHERE id = ?`,
      [...Object.values(cols), existing.id]);
    return { id: existing.id, number: existing.number, action: 'updated' };
  } else {
    const id = uuid();
    const number = await allocateNumber(env, 'Q-WFM');
    await run(env.DB,
      `INSERT INTO quotes
         (id, number, external_source, external_id, opportunity_id,
          title, description, quote_type, status, valid_until,
          subtotal_price, tax_amount, total_price, notes_customer,
          wfm_number, wfm_type, wfm_state, wfm_budget, wfm_payload,
          created_at, updated_at)
       VALUES (?, ?, 'wfm', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, number, q.UUID, opportunityId,
       cols.title, cols.description, cols.quote_type, cols.status, cols.valid_until,
       cols.subtotal_price, cols.tax_amount, cols.total_price, cols.notes_customer,
       cols.wfm_number, cols.wfm_type, cols.wfm_state, cols.wfm_budget, cols.wfm_payload,
       ts, ts]);
    return { id, number, action: 'created' };
  }
}

// ---------- On-demand WFM fetch helpers (for FK auto-cascade) ----------
//
// When the user selects, say, a single quote whose parent lead isn't in
// the same batch (and isn't already in Pipeline), we fetch the missing
// parent on the fly. Cache the fetches in a per-request Map so the same
// account/lead isn't re-fetched if multiple selections share a parent.

async function fetchClientDetail(env, wfmUuid, cache) {
  if (!wfmUuid) return null;
  if (cache.has('client:' + wfmUuid)) return cache.get('client:' + wfmUuid);
  const r = await apiGet(env, '/client.api/get/' + encodeURIComponent(wfmUuid));
  if (!r.ok) { cache.set('client:' + wfmUuid, null); return null; }
  const c = recordList(r.body, 'Client')[0] || null;
  cache.set('client:' + wfmUuid, c);
  return c;
}

async function fetchLeadDetail(env, wfmUuid, cache) {
  if (!wfmUuid) return null;
  if (cache.has('lead:' + wfmUuid)) return cache.get('lead:' + wfmUuid);
  const r = await apiGet(env, '/lead.api/get/' + encodeURIComponent(wfmUuid));
  if (!r.ok) { cache.set('lead:' + wfmUuid, null); return null; }
  const l = recordList(r.body, 'Lead')[0] || null;
  cache.set('lead:' + wfmUuid, l);
  return l;
}

// Get-or-import an account by WFM UUID. If we've already imported it
// (in this batch or a previous run), returns the Pipeline id. Otherwise
// fetches /client.api/get/{uuid}, imports it (with nested contacts),
// and returns the new id. Returns null if the WFM record is missing.
async function ensureAccount(env, wfmUuid, ctx) {
  if (!wfmUuid) return null;
  if (ctx.accountByWfmUuid.has(wfmUuid)) return ctx.accountByWfmUuid.get(wfmUuid);
  const c = await fetchClientDetail(env, wfmUuid, ctx.fetchCache);
  if (!c) return null;
  const r = await upsertAccount(env, c);
  ctx.accountByWfmUuid.set(wfmUuid, r.id);
  ctx.counts.accounts_cascaded++;
  if (r.action === 'claimed') ctx.counts.accounts_claimed++;

  const cts = (c.Contacts && c.Contacts.Contact)
    ? (Array.isArray(c.Contacts.Contact) ? c.Contacts.Contact : [c.Contacts.Contact])
    : [];
  for (const ct of cts) {
    const ctr = await upsertContact(env, ct, r.id);
    ctx.contactByWfmUuid.set(ct.UUID, ctr.id);
    ctx.counts.contacts_cascaded++;
    if (ctr.action === 'claimed') ctx.counts.contacts_claimed++;
  }
  return r.id;
}

// Get-or-import a lead-derived opportunity by WFM Lead UUID. Cascades
// account+contacts if the parent client isn't in our maps.
async function ensureOpportunityFromLead(env, wfmLeadUuid, ctx) {
  if (!wfmLeadUuid) return null;
  if (ctx.oppByWfmUuid.has(wfmLeadUuid)) return ctx.oppByWfmUuid.get(wfmLeadUuid);
  const lead = await fetchLeadDetail(env, wfmLeadUuid, ctx.fetchCache);
  if (!lead) return null;

  const accountId = lead.Client?.UUID
    ? await ensureAccount(env, lead.Client.UUID, ctx)
    : null;
  if (!accountId) return null;
  const contactId = lead.Contact?.UUID
    ? (ctx.contactByWfmUuid.get(lead.Contact.UUID) || null)
    : null;
  const ownerId = lead.Owner?.UUID
    ? (ctx.userByWfmUuid.get(lead.Owner.UUID) || null)
    : null;

  const o = await upsertOpportunityFromLead(env, lead, accountId, contactId, ownerId);
  ctx.oppByWfmUuid.set(wfmLeadUuid, o.id);
  ctx.counts.opportunities_cascaded++;
  return o.id;
}

async function enrichUserFromStaff(env, st) {
  const email = String(st.Email || '').toLowerCase().trim();
  if (!email) return null;
  const existing = await one(env.DB,
    'SELECT id FROM users WHERE LOWER(email) = ?', [email]);
  if (!existing) return null;
  await run(env.DB,
    `UPDATE users
        SET external_source = 'wfm', external_id = ?, external_url = ?,
            wfm_payload = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
    [st.UUID, s(st.WebURL), JSON.stringify(st), existing.id]);
  return existing.id;
}

// ---------- Main entry point ----------

export async function onRequestPost(context) {
  const { env, request, data } = context;
  const user = data?.user;
  if (!user) return json({ ok: false, error: 'sign_in_required' }, 401);
  if (!hasRole(user, 'admin')) return json({ ok: false, error: 'admin_only' }, 403);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const samples = body?.samples || {};

  // Build lookup maps as we go.
  const accountByWfmUuid = new Map();
  const contactByWfmUuid = new Map();
  const userByWfmUuid    = new Map();
  const oppByWfmUuid     = new Map();

  // Pre-load all WFM-mapped accounts/contacts/opps so leads/quotes
  // referencing earlier imports (not in this batch) still resolve.
  const priorAccounts = await all(env.DB,
    'SELECT id, external_id FROM accounts WHERE external_source = ?', ['wfm']);
  for (const r of priorAccounts) accountByWfmUuid.set(r.external_id, r.id);
  const priorContacts = await all(env.DB,
    'SELECT id, external_id FROM contacts WHERE external_source = ?', ['wfm']);
  for (const r of priorContacts) contactByWfmUuid.set(r.external_id, r.id);
  const priorUsers = await all(env.DB,
    'SELECT id, external_id FROM users WHERE external_source = ?', ['wfm']);
  for (const r of priorUsers) userByWfmUuid.set(r.external_id, r.id);
  const priorOpps = await all(env.DB,
    'SELECT id, external_id FROM opportunities WHERE external_source IN (?, ?)',
    ['wfm-lead', 'wfm-job']);
  for (const r of priorOpps) oppByWfmUuid.set(r.external_id, r.id);

  const counts = {
    accounts: 0, contacts: 0, opportunities: 0, quotes: 0,
    users: 0, jobs: 0, skipped: 0,
    // Records imported via auto-cascade (parent FK was missing).
    accounts_cascaded: 0, contacts_cascaded: 0, opportunities_cascaded: 0,
    // Records claimed: a Pipeline-native row was found by name/email
    // and stamped with the WFM external_id (rather than creating a
    // new row alongside the existing one).
    accounts_claimed: 0, contacts_claimed: 0,
  };
  const links = [];
  const errors = [];

  // Per-request fetch cache so we don't re-pull /client.api/get/{X}
  // 5 times if 5 selected leads all reference the same client.
  const fetchCache = new Map();
  const ctx = {
    accountByWfmUuid, contactByWfmUuid, userByWfmUuid, oppByWfmUuid,
    fetchCache, counts,
  };

  try {
    // -------- Staff ---------
    for (const st of (samples.staff || [])) {
      try {
        const userId = await enrichUserFromStaff(env, st);
        if (userId) { userByWfmUuid.set(st.UUID, userId); counts.users++; }
        else counts.skipped++;
      } catch (e) { errors.push(`staff ${st?.Name}: ${e.message}`); }
    }

    // -------- Clients (+ nested contacts) ---------
    for (const c of (samples.clients || [])) {
      try {
        const a = await upsertAccount(env, c);
        accountByWfmUuid.set(c.UUID, a.id);
        counts.accounts++;
        if (a.action === 'claimed') counts.accounts_claimed++;
        links.push({ url: '/accounts/' + a.id, label: 'Account: ' + (c.Name || c.UUID) });

        const cts = (c.Contacts && c.Contacts.Contact)
          ? (Array.isArray(c.Contacts.Contact) ? c.Contacts.Contact : [c.Contacts.Contact])
          : [];
        for (const ct of cts) {
          const r = await upsertContact(env, ct, a.id);
          contactByWfmUuid.set(ct.UUID, r.id);
          counts.contacts++;
          if (r.action === 'claimed') counts.contacts_claimed++;
        }
      } catch (e) { errors.push('client ' + (c?.Name || '?') + ': ' + e.message); }
    }

    // -------- Leads ---------
    for (const lead of (samples.leads || [])) {
      try {
        // Auto-cascade: if the lead's parent Client isn't in the
        // current batch and isn't already in Pipeline, fetch it from
        // WFM and import it on the fly.
        const accountId = lead.Client?.UUID
          ? await ensureAccount(env, lead.Client.UUID, ctx)
          : null;
        if (!accountId) { counts.skipped++; continue; }
        const contactId = lead.Contact?.UUID ? contactByWfmUuid.get(lead.Contact.UUID) : null;
        const ownerId   = lead.Owner?.UUID   ? userByWfmUuid.get(lead.Owner.UUID)      : null;
        const o = await upsertOpportunityFromLead(env, lead, accountId, contactId, ownerId);
        oppByWfmUuid.set(lead.UUID, o.id);
        counts.opportunities++;
        links.push({ url: '/opportunities/' + o.id, label: 'Opp: ' + (lead.Name || o.number) });
      } catch (e) { errors.push('lead ' + (lead?.Name || '?') + ': ' + e.message); }
    }

    // -------- Quotes ---------
    for (const q of (samples.quotes || [])) {
      try {
        // Auto-cascade: if the quote's parent Lead isn't in the
        // current batch and isn't in Pipeline, fetch the Lead (which
        // recursively cascades the Client) and import it.
        let oppId = null;
        if (q.LeadUUID) oppId = await ensureOpportunityFromLead(env, q.LeadUUID, ctx);
        // (JobUUID cascade — not yet wired; falls through to skip.)
        if (!oppId && q.JobUUID) oppId = oppByWfmUuid.get(q.JobUUID) || null;
        if (!oppId) { counts.skipped++; continue; }
        const r = await upsertQuote(env, q, oppId);
        counts.quotes++;
        links.push({ url: '/opportunities/' + oppId + '/quotes/' + r.id, label: 'Quote: ' + (q.Name || r.number) });
      } catch (e) { errors.push('quote ' + (q?.Name || '?') + ': ' + e.message); }
    }

    // -------- Jobs ---------
    for (const job of (samples.jobs || [])) {
      try {
        const accountId = job.Client?.UUID
          ? await ensureAccount(env, job.Client.UUID, ctx)
          : null;
        if (!accountId) { counts.skipped++; continue; }
        const ownerId = job.Manager?.UUID ? userByWfmUuid.get(job.Manager.UUID) : null;
        const o = await upsertOpportunityFromJob(env, job, accountId, ownerId);
        oppByWfmUuid.set(job.UUID, o.id);
        counts.jobs++;
        links.push({ url: '/opportunities/' + o.id, label: 'Job-opp: ' + (job.Name || o.number) });
      } catch (e) { errors.push('job ' + (job?.Name || '?') + ': ' + e.message); }
    }

    return json({
      ok: true,
      counts,
      summary:
        counts.accounts + ' accounts'
        + ' · ' + counts.contacts + ' contacts'
        + ' · ' + counts.opportunities + ' opps from leads'
        + ' · ' + counts.quotes + ' quotes'
        + ' · ' + counts.jobs + ' opps from jobs'
        + ' · ' + counts.users + ' users enriched'
        + ' · ' + counts.skipped + ' skipped (FK unresolved)'
        + ((counts.accounts_cascaded + counts.contacts_cascaded + counts.opportunities_cascaded) > 0
            ? ' · auto-cascaded: ' + counts.accounts_cascaded + ' accounts, '
              + counts.contacts_cascaded + ' contacts, '
              + counts.opportunities_cascaded + ' opps'
            : '')
        + ((counts.accounts_claimed + counts.contacts_claimed) > 0
            ? ' · claimed (matched existing Pipeline rows by name): '
              + counts.accounts_claimed + ' accounts, '
              + counts.contacts_claimed + ' contacts'
            : ''),
      links: links.slice(0, 30),  // cap so the UI stays readable
      errors: errors.slice(0, 10),
    });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err), counts, links, errors }, 500);
  }
}
