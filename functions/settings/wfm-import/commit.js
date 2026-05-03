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
  //    (case-insensitive, trimmed). The exact-UUID path (step 1)
  //    already handled the idempotent case, so we just need to
  //    exclude that specific row from the smart-match. Everything
  //    else is fair game:
  //      - Pipeline-native rows (external_source IS NULL)
  //      - Other-system imports (Xero, etc.)
  //      - Legacy WFM rows with slug-style external_ids (e.g.
  //        external_id='rovop-inc' from the old wfm-import.mjs
  //        script before we moved to real UUIDs). These should be
  //        re-stamped with the proper UUID — they ARE the same
  //        logical record, just under a different ID convention.
  let claimed = false;
  if (!existing && s(c.Name)) {
    const match = await one(env.DB,
      `SELECT id, external_source, external_id FROM accounts
        WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))
          AND NOT (external_source = 'wfm' AND external_id = ?)
        LIMIT 1`,
      [s(c.Name), c.UUID]);
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

  let pipelineId;
  let action;
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
    pipelineId = existing.id;
    action = claimed ? 'claimed' : 'updated';
  } else {
    pipelineId = uuid();
    await run(env.DB,
      `INSERT INTO accounts
         (id, external_source, external_id,
          name, email, phone, fax, website,
          address_billing, address_physical, external_url,
          account_manager_name, referral_source, export_code,
          is_archived, is_prospect, is_deleted, wfm_payload,
          created_at, updated_at)
       VALUES (?, 'wfm', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [pipelineId, c.UUID,
       cols.name, cols.email, cols.phone, cols.fax, cols.website,
       cols.address_billing, cols.address_physical, cols.external_url,
       cols.account_manager_name, cols.referral_source, cols.export_code,
       cols.is_archived, cols.is_prospect, cols.is_deleted, cols.wfm_payload,
       ts, ts]);
    action = 'created';
  }

  // Sync addresses into the normalized account_addresses table —
  // that's what the account-detail UI actually displays. Idempotent
  // on (account_id, external_source='wfm', external_id).
  await syncAccountAddresses(env, pipelineId, c, ts);

  return { id: pipelineId, action };
}

// Build address rows for an imported WFM Client and reconcile them
// against existing wfm-sourced addresses on the account. Each address
// gets a stable external_id ('billing' or 'physical') so re-imports
// update in place rather than duplicating.
//
// Mapping:
//   WFM Address (street/visiting)   → kind='physical'
//   WFM PostalAddress (mail/billing) → kind='billing'
//
// User-added (non-wfm) address rows on the same account are left
// untouched — only wfm-sourced rows are deleted/re-inserted.
async function syncAccountAddresses(env, accountId, c, ts) {
  // Build the two candidate address blocks.
  const lines = (...vals) => vals.filter((v) => v && String(v).trim()).join('\n');
  const physicalText = lines(
    s(c.Address),
    [s(c.City), s(c.Region)].filter(Boolean).join(' '),
    [s(c.PostCode), s(c.Country)].filter(Boolean).join(' ')
  );
  const billingText = lines(
    s(c.PostalAddress),
    [s(c.PostalCity), s(c.PostalRegion)].filter(Boolean).join(' '),
    [s(c.PostalPostCode), s(c.PostalCountry)].filter(Boolean).join(' ')
  );

  // Remove wfm-sourced address rows for this account.
  await run(env.DB,
    `DELETE FROM account_addresses
      WHERE account_id = ? AND external_source = 'wfm'`,
    [accountId]);

  let isFirst = true;
  if (physicalText.trim()) {
    await run(env.DB,
      `INSERT INTO account_addresses
         (id, account_id, kind, label, address, is_default,
          external_source, external_id, created_at, updated_at)
       VALUES (?, ?, 'physical', ?, ?, ?, 'wfm', 'physical', ?, ?)`,
      [uuid(), accountId, 'WFM physical', physicalText, isFirst ? 1 : 0, ts, ts]);
    isFirst = false;
  }
  if (billingText.trim()) {
    await run(env.DB,
      `INSERT INTO account_addresses
         (id, account_id, kind, label, address, is_default,
          external_source, external_id, created_at, updated_at)
       VALUES (?, ?, 'billing', ?, ?, ?, 'wfm', 'billing', ?, ?)`,
      [uuid(), accountId, 'WFM billing/postal', billingText, isFirst ? 1 : 0, ts, ts]);
  }
}

async function upsertContact(env, ct, accountId) {
  // 1) Already WFM-imported?
  let existing = await one(env.DB,
    'SELECT id FROM contacts WHERE external_source = ? AND external_id = ?',
    ['wfm', ct.UUID]);

  // 2) Smart-match against an existing contact on the same account.
  //    Email match first (most reliable), name fallback. Excludes
  //    only the exact incoming-UUID row (idempotent path already
  //    handled) — legacy slug-based wfm contacts get re-stamped
  //    with proper UUIDs.
  let claimed = false;
  const split = splitName(ct.Name);
  if (!existing) {
    if (s(ct.Email)) {
      existing = await one(env.DB,
        `SELECT id FROM contacts
          WHERE account_id = ?
            AND NOT (external_source = 'wfm' AND external_id = ?)
            AND LOWER(TRIM(email)) = LOWER(TRIM(?))
          LIMIT 1`,
        [accountId, ct.UUID, s(ct.Email)]);
      if (existing) claimed = true;
    }
    if (!existing && split.first_name && split.last_name) {
      existing = await one(env.DB,
        `SELECT id FROM contacts
          WHERE account_id = ?
            AND NOT (external_source = 'wfm' AND external_id = ?)
            AND LOWER(TRIM(first_name)) = LOWER(TRIM(?))
            AND LOWER(TRIM(last_name)) = LOWER(TRIM(?))
          LIMIT 1`,
        [accountId, ct.UUID, split.first_name, split.last_name]);
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

async function fetchQuoteDetail(env, wfmUuid, cache) {
  if (!wfmUuid) return null;
  if (cache.has('quote:' + wfmUuid)) return cache.get('quote:' + wfmUuid);
  const r = await apiGet(env, '/quote.api/get/' + encodeURIComponent(wfmUuid));
  if (!r.ok) { cache.set('quote:' + wfmUuid, null); return null; }
  const q = recordList(r.body, 'Quote')[0] || null;
  cache.set('quote:' + wfmUuid, q);
  return q;
}

async function fetchJobDetail(env, wfmUuid, cache) {
  if (!wfmUuid) return null;
  if (cache.has('job:' + wfmUuid)) return cache.get('job:' + wfmUuid);
  const r = await apiGet(env, '/job.api/get/' + encodeURIComponent(wfmUuid));
  if (!r.ok) { cache.set('job:' + wfmUuid, null); return null; }
  const j = recordList(r.body, 'Job')[0] || null;
  cache.set('job:' + wfmUuid, j);
  return j;
}

// Walk DetailedQuote.{Costs,Tasks} arrays and produce Pipeline
// quote_lines rows. Each line gets its own per-line cost_build
// (manual-mode, total_cost_source='manual') storing the WFM cost
// basis vs. customer price with margin computed. quote_lines
// references the cost_build via cost_build_id so the per-row
// "Build" column lights up.
//
// Idempotent on (external_source='wfm', external_id=<line UUID>):
// DELETEs all WFM-sourced lines AND their per-line cost_builds for
// the quote first, then re-INSERTs. User-added (non-wfm) lines and
// builds are preserved.
async function syncQuoteLines(env, pipelineQuoteId, wfmQuoteUuid, ctx) {
  const detail = await fetchQuoteDetail(env, wfmQuoteUuid, ctx.fetchCache);
  if (!detail) return 0;

  // Get the parent opportunity (cost_builds.opportunity_id is a
  // required FK).
  const quoteRow = await one(env.DB,
    'SELECT opportunity_id FROM quotes WHERE id = ?', [pipelineQuoteId]);
  if (!quoteRow) return 0;
  const opportunityId = quoteRow.opportunity_id;

  // Persist the full DetailedQuote (including Costs/Tasks/Options)
  // onto the quote row's wfm_payload, replacing the lighter
  // current-list payload that upsertQuote stored.
  await run(env.DB,
    'UPDATE quotes SET wfm_payload = ? WHERE id = ?',
    [JSON.stringify(detail), pipelineQuoteId]);

  // Helper: WFM XML wraps repeated children as <Plural><Singular/></Plural>.
  // After parsing, that's typically { Plural: { Singular: [...] } } when
  // multiple children exist, or { Plural: { Singular: {...} } } for one,
  // or "" / undefined when empty.
  const arrayOf = (field, primaryKey) => {
    if (!field || typeof field !== 'object') return [];
    if (Array.isArray(field)) return field;
    const inner = field[primaryKey];
    if (Array.isArray(inner)) return inner;
    if (inner && typeof inner === 'object') return [inner];
    return [];
  };

  const lines = [];
  let sortOrder = 10;

  // Pattern for "looks like a part number": single token, alphanumeric
  // with hyphens/dots/slashes/underscores, length 2..29. Used as a
  // fallback when WFM Cost has no separate Code field — many parts
  // quotes use Description as the part number directly.
  const PART_NUM_RE = /^[A-Za-z0-9][\w\-./]{1,28}$/;

  for (const c of arrayOf(detail.Costs, 'Cost')) {
    const code = s(c.Code) || s(c.PartNumber) || s(c.SKU) || '';
    const desc = s(c.Description) || s(c.Note) || '';

    let partNumber = code;
    let description = desc;
    if (!partNumber && desc && !desc.includes(' ') && PART_NUM_RE.test(desc)) {
      partNumber = desc;
      description = '';
    }

    const quantity  = n(c.Quantity) || 1;
    const unitPrice = n(c.UnitPrice) || 0;
    // WFM Costs may have UnitCost (the cost basis) separately from
    // UnitPrice (customer price). Fall back to UnitPrice when no
    // separate cost field is provided — margin will be 0 in that
    // case but the user can edit it later.
    const unitCost  = n(c.UnitCost) || unitPrice;
    const extPrice  = n(c.Amount) || n(c.Total) || (quantity * unitPrice);
    const extCost   = quantity * unitCost;

    lines.push({
      // WFM sometimes returns Cost entries with empty UUID. Scoping
      // the fallback to the parent WFM quote UUID keeps the global
      // unique index on (quote_lines.external_source, external_id)
      // happy across multiple imported quotes.
      external_id: s(c.UUID) || (wfmQuoteUuid + ':cost:' + sortOrder),
      sort_order:  sortOrder, item_type: 'product',
      title:       s(c.Title) || '',
      part_number: partNumber,
      description: description || (partNumber ? '' : '(no description)'),
      quantity,
      unit:        s(c.Unit) || '',
      unit_price:  unitPrice,
      unit_cost:   unitCost,
      ext_price:   extPrice,
      ext_cost:    extCost,
      wfm_payload: JSON.stringify(c),
    });
    sortOrder += 10;
  }

  for (const t of arrayOf(detail.Tasks, 'Task')) {
    const qty = n(t.Quantity) || n(t.BillableMinutes) || n(t.EstimatedMinutes) || 1;
    const unit = s(t.Unit)
      || (n(t.BillableMinutes) || n(t.EstimatedMinutes) ? 'min' : 'hr');
    const rate = n(t.BillableRate) || n(t.Rate) || 0;
    // Labor cost basis: WFM Task may have CostRate or UnitCost; if
    // not, fall back to the billable rate (margin=0).
    const cost = n(t.CostRate) || n(t.UnitCost) || rate;
    const extPrice = n(t.Amount) || n(t.Total) || (qty * rate);
    const extCost  = qty * cost;

    lines.push({
      // Same scoping fix as the Cost branch above.
      external_id: s(t.UUID) || (wfmQuoteUuid + ':task:' + sortOrder),
      sort_order:  sortOrder, item_type: 'labor',
      title:       s(t.Title) || s(t.Name) || '',
      part_number: '',
      description: s(t.Description) || s(t.Name) || '(no description)',
      quantity:    qty,
      unit,
      unit_price:  rate,
      unit_cost:   cost,
      ext_price:   extPrice,
      ext_cost:    extCost,
      wfm_payload: JSON.stringify(t),
    });
    sortOrder += 10;
  }

  // Idempotency: there's a circular FK between quote_lines and
  // cost_builds (cost_builds.quote_line_id → quote_lines AND
  // quote_lines.cost_build_id → cost_builds). Both with NO ACTION on
  // delete, so we have to break the cycle manually:
  //   1. NULL out quote_lines.cost_build_id on the wfm rows so the
  //      cost_builds DELETE in step 2 doesn't fail on a back-pointer.
  //   2. DELETE the cost_builds linked via quote_line_id.
  //   3. DELETE the quote_lines.
  // User-added (non-wfm) quote_lines + cost_builds are preserved.
  await run(env.DB,
    `UPDATE quote_lines
        SET cost_build_id = NULL
      WHERE quote_id = ? AND external_source = 'wfm' AND cost_build_id IS NOT NULL`,
    [pipelineQuoteId]);

  const oldLines = await all(env.DB,
    `SELECT id FROM quote_lines
      WHERE quote_id = ? AND external_source = 'wfm'`,
    [pipelineQuoteId]);
  const oldQuoteLineIds = oldLines.map((r) => r.id);

  if (oldQuoteLineIds.length > 0) {
    const placeholders = oldQuoteLineIds.map(() => '?').join(',');
    await run(env.DB,
      'DELETE FROM cost_builds WHERE quote_line_id IN (' + placeholders + ')',
      oldQuoteLineIds);
  }

  await run(env.DB,
    `DELETE FROM quote_lines WHERE quote_id = ? AND external_source = 'wfm'`,
    [pipelineQuoteId]);

  // Insert quote_line first (so we have its id to backref from
  // cost_builds.quote_line_id), then insert cost_build pointing back.
  const ts = nowIso();
  for (const line of lines) {
    const qlId = uuid();
    await run(env.DB,
      `INSERT INTO quote_lines
         (id, quote_id, external_source, external_id,
          sort_order, item_type, title, part_number, description,
          quantity, unit, unit_price, extended_price,
          wfm_payload, created_at, updated_at)
       VALUES (?, ?, 'wfm', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [qlId, pipelineQuoteId, line.external_id,
       line.sort_order, line.item_type, line.title, line.part_number, line.description,
       line.quantity, line.unit, line.unit_price, line.ext_price,
       line.wfm_payload, ts, ts]);

    // Per-line cost_build. Pipeline's cost_builds schema decomposes
    // cost into 4 buckets (dm/dl/imoh/other) — for WFM imports we
    // dump the rolled-up cost into the appropriate bucket based on
    // line type:
    //   product → dm_user_cost (Direct Materials)
    //   labor   → dl_user_cost (Direct Labor)
    // Price is the unified quote_price_user.
    const cbId = uuid();
    const labelSrc = (line.part_number || line.title || line.description || line.external_id);
    const label = 'WFM: ' + String(labelSrc).slice(0, 70);
    const dmCost = (line.item_type === 'product') ? line.ext_cost : 0;
    const dlCost = (line.item_type === 'labor')   ? line.ext_cost : 0;

    await run(env.DB,
      `INSERT INTO cost_builds
         (id, opportunity_id, quote_line_id, label, status, build_kind,
          dm_user_cost, dl_user_cost, imoh_user_cost, other_user_cost,
          quote_price_user,
          use_dm_library, use_labor_library, discount_is_phantom,
          notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', 'wfm_reference',
               ?, ?, 0, 0,
               ?,
               0, 0, 0,
               ?, ?, ?)`,
      [cbId, opportunityId, qlId, label,
       dmCost, dlCost, line.ext_price,
       'WFM-imported (qty ' + line.quantity + ' × cost ' + line.unit_cost.toFixed(4) + ' / price ' + line.unit_price.toFixed(4) + ')',
       ts, ts]);
  }

  return lines.length;
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

// WFM Quote.State → Pipeline opportunity stage. Used when synthesizing
// a stub opportunity from an orphan quote (no parent Lead/Job).
const QUOTE_STATE_TO_OPP_STAGE = {
  Draft:    'quote_drafted',
  Issued:   'quote_submitted',
  Accepted: 'won',
  Declined: 'lost',
  Archived: 'abandoned',
};

// Synthesize a standalone opportunity from a quote that has no parent
// Lead/Job in WFM (or whose parent is inaccessible). Used when the
// user opts into options.synth_orphan_quotes on the import. The
// account FK is auto-cascaded from quote.Client.UUID. If no client
// is set or cascade fails, returns null and the quote will skip.
async function synthesizeOpportunityFromQuote(env, q, ctx) {
  const accountId = q.Client?.UUID
    ? await ensureAccount(env, q.Client.UUID, ctx)
    : null;
  if (!accountId) return null;

  // Reuse cache key if we've already synthesized this opp in the same
  // batch (idempotency for the request lifetime).
  const cacheKey = 'orphan-quote:' + q.UUID;
  if (ctx.oppByWfmUuid.has(cacheKey)) return ctx.oppByWfmUuid.get(cacheKey);

  // Idempotent at the DB level too: re-keyed on (wfm-quote-orphan, q.UUID).
  const existing = await one(env.DB,
    'SELECT id, number FROM opportunities WHERE external_source = ? AND external_id = ?',
    ['wfm-quote-orphan', q.UUID]);

  const stage = QUOTE_STATE_TO_OPP_STAGE[q.State] || 'quote_drafted';
  const contactId = q.Contact?.UUID
    ? (ctx.contactByWfmUuid.get(q.Contact.UUID) || null)
    : null;

  const noteLine = '[WFM] Synthesized from orphan quote ' +
    (q.ID || q.UUID || '?') +
    ' — no parent Lead/Job in WFM at import time.';

  const ts = nowIso();
  const cols = {
    title:               s(q.Name) || ('Quote ' + (q.ID || q.UUID || '')),
    description:         s(q.Description),
    transaction_type:    'spares',     // best-guess default; user can edit
    stage,
    estimated_value_usd: n(q.AmountIncludingTax),
    account_id:          accountId,
    primary_contact_id:  contactId,
    notes_internal:      noteLine,
    wfm_payload:         JSON.stringify(q),
    updated_at:          ts,
  };

  let oppId, oppNumber;
  if (existing) {
    const setClause = Object.keys(cols).map((k) => `${k} = ?`).join(', ');
    await run(env.DB,
      `UPDATE opportunities SET ${setClause} WHERE id = ?`,
      [...Object.values(cols), existing.id]);
    oppId = existing.id; oppNumber = existing.number;
  } else {
    oppId = uuid();
    oppNumber = await allocateNumber(env, 'OPP-WFM');
    await run(env.DB,
      `INSERT INTO opportunities
         (id, number, external_source, external_id,
          account_id, primary_contact_id,
          title, description, transaction_type, stage,
          estimated_value_usd,
          notes_internal, wfm_payload,
          stage_entered_at, created_at, updated_at)
       VALUES (?, ?, 'wfm-quote-orphan', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [oppId, oppNumber, q.UUID,
       accountId, contactId,
       cols.title, cols.description, cols.transaction_type, cols.stage,
       cols.estimated_value_usd,
       cols.notes_internal, cols.wfm_payload,
       ts, ts, ts]);
  }

  ctx.oppByWfmUuid.set(cacheKey, oppId);
  ctx.counts.opportunities_synthesized = (ctx.counts.opportunities_synthesized || 0) + 1;
  return oppId;
}

// Get-or-import a job-derived opportunity by WFM Job UUID. Cascades
// account if the parent client isn't in our maps. Mirrors
// ensureOpportunityFromLead but for the JobUUID FK path that quotes
// can take when there's no parent Lead.
async function ensureOpportunityFromJob(env, wfmJobUuid, ctx) {
  if (!wfmJobUuid) return null;
  if (ctx.oppByWfmUuid.has(wfmJobUuid)) return ctx.oppByWfmUuid.get(wfmJobUuid);
  const job = await fetchJobDetail(env, wfmJobUuid, ctx.fetchCache);
  if (!job) return null;

  const accountId = job.Client?.UUID
    ? await ensureAccount(env, job.Client.UUID, ctx)
    : null;
  if (!accountId) return null;
  const ownerId = job.Manager?.UUID
    ? (ctx.userByWfmUuid.get(job.Manager.UUID) || null)
    : null;

  const o = await upsertOpportunityFromJob(env, job, accountId, ownerId);
  ctx.oppByWfmUuid.set(wfmJobUuid, o.id);
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

// Build a lightweight summary of what the user submitted, for the
// persisted run log. We capture {kind, id, uuid, name} per record
// rather than full WFM payloads so the row stays small.
function summarizeSelection(samples) {
  const out = [];
  if (!samples || typeof samples !== 'object') return out;
  for (const [plural, arr] of Object.entries(samples)) {
    if (!Array.isArray(arr)) continue;
    // Strip the trailing 's' for a cleaner singular kind label.
    const kind = plural.endsWith('s') ? plural.slice(0, -1) : plural;
    for (const rec of arr) {
      out.push({
        kind,
        id:   rec?.ID || '',
        uuid: rec?.UUID || '',
        name: rec?.Name || rec?.ID || rec?.UUID || '',
      });
    }
  }
  return out;
}

// Persist one row in wfm_import_runs at the tail of every commit
// invocation (success or failure). Best-effort — if the write fails
// we still return the import result to the caller.
async function recordImportRun(env, runRow) {
  try {
    await run(env.DB,
      `INSERT INTO wfm_import_runs
         (id, started_at, finished_at, triggered_by, ok, summary,
          counts_json, errors_json, links_json,
          selection_summary_json, selection_size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        runRow.id,
        runRow.started_at,
        runRow.finished_at,
        runRow.triggered_by || null,
        runRow.ok ? 1 : 0,
        runRow.summary || null,
        JSON.stringify(runRow.counts || {}),
        JSON.stringify(runRow.errors || []),
        JSON.stringify(runRow.links || []),
        JSON.stringify(runRow.selection_summary || []),
        runRow.selection_size || 0,
      ]
    );
  } catch (err) {
    // Don't fail the whole import on a logging failure — but surface
    // it on the server console so we know to investigate.
    console.error('[wfm-import] failed to persist run row:', err);
  }
}

function genRunId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for envs without crypto.randomUUID (vanishingly rare on
  // modern Workers). Random 16-byte hex string.
  return 'run-' + Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
}

export async function onRequestPost(context) {
  const { env, request, data } = context;
  const user = data?.user;
  if (!user) return json({ ok: false, error: 'sign_in_required' }, 401);
  if (!hasRole(user, 'admin')) return json({ ok: false, error: 'admin_only' }, 403);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const samples = body?.samples || {};

  // Bookkeeping for the persisted run log.
  const runId        = genRunId();
  const runStartedAt = nowIso();
  const triggeredBy  = user?.email || '';
  const selectionSummary = summarizeSelection(samples);

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
    'SELECT id, external_id FROM opportunities WHERE external_source IN (?, ?, ?)',
    ['wfm-lead', 'wfm-job', 'wfm-quote-orphan']);
  for (const r of priorOpps) oppByWfmUuid.set(r.external_id, r.id);

  // Import options. Currently:
  //   synth_orphan_quotes: when a quote has no resolvable parent
  //     (no LeadUUID/JobUUID, OR cascade fails because parent is
  //     archived/deleted in WFM), synthesize a stub opportunity from
  //     the quote's own fields. external_source='wfm-quote-orphan'.
  const options = (body && body.options) || {};
  const synthOrphanQuotes = !!options.synth_orphan_quotes;

  const counts = {
    accounts: 0, contacts: 0, opportunities: 0, quotes: 0,
    users: 0, jobs: 0, skipped: 0,
    quote_lines: 0,
    // Records imported via auto-cascade (parent FK was missing).
    accounts_cascaded: 0, contacts_cascaded: 0, opportunities_cascaded: 0,
    // Records claimed: a Pipeline-native row was found by name/email
    // and stamped with the WFM external_id (rather than creating a
    // new row alongside the existing one).
    accounts_claimed: 0, contacts_claimed: 0,
    // Stub opps synthesized from orphan/stranded quotes (when
    // options.synth_orphan_quotes is on).
    opportunities_synthesized: 0,
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
    for (const cInput of (samples.clients || [])) {
      try {
        // The /client.api/list endpoint returns clients WITHOUT their
        // Contacts array (those live on the per-client detail). When
        // the caller passed a list-shaped record (no Contacts key),
        // fetch the detail now so we don't drop the contacts on the
        // floor. Sample-based imports already pre-fetch detail in
        // sample.js, so this hits only on the full-import path.
        let c = cInput;
        if (!c.Contacts && c.UUID) {
          try {
            const detailResp = await apiGet(env, '/client.api/get/' + encodeURIComponent(c.UUID));
            if (detailResp.ok) {
              const detailC = recordList(detailResp.body, 'Client')[0];
              if (detailC) c = detailC;
            }
          } catch (_) { /* fall through with list-shaped record */ }
        }

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
        if (!accountId) {
          counts.skipped++;
          errors.push('lead "' + (lead?.Name || lead?.UUID || '?') +
            '" skipped: ' +
            (lead.Client?.UUID
              ? 'client UUID ' + lead.Client.UUID + ' could not be resolved (cascade fetch failed?)'
              : 'no Client.UUID on lead'));
          continue;
        }
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
        // Auto-cascade: if the quote's parent Lead/Job isn't in the
        // current batch and isn't in Pipeline, fetch it from WFM
        // (which recursively cascades the Client) and import on the fly.
        let oppId = null;
        let synthesized = false;
        if (q.LeadUUID) oppId = await ensureOpportunityFromLead(env, q.LeadUUID, ctx);
        if (!oppId && q.JobUUID) oppId = await ensureOpportunityFromJob(env, q.JobUUID, ctx);
        // Last-resort synthesizer: if cascades failed AND the user opted
        // in, synthesize a stub opportunity from the quote's own fields.
        if (!oppId && synthOrphanQuotes) {
          oppId = await synthesizeOpportunityFromQuote(env, q, ctx);
          if (oppId) {
            synthesized = true;
            links.push({
              url: '/opportunities/' + oppId,
              label: 'Synthesized opp: ' + (q.Name || q.ID || q.UUID || '?'),
            });
          }
        }
        if (!oppId) {
          counts.skipped++;
          let reason;
          if (!q.LeadUUID && !q.JobUUID) {
            reason = 'orphan quote: no LeadUUID and no JobUUID set on the WFM record';
          } else if (q.LeadUUID && !q.JobUUID) {
            reason = 'LeadUUID ' + q.LeadUUID + ' present but cascade failed (lead missing/archived/inaccessible in WFM?)';
          } else if (!q.LeadUUID && q.JobUUID) {
            reason = 'JobUUID ' + q.JobUUID + ' present but cascade failed (job missing/inaccessible in WFM?)';
          } else {
            reason = 'both LeadUUID (' + q.LeadUUID + ') and JobUUID (' + q.JobUUID + ') present, neither cascade succeeded';
          }
          if (!synthOrphanQuotes) {
            reason += ' (enable "Synthesize standalone opportunities for orphan quotes" to import anyway)';
          } else {
            // Synth was on but still failed — that means the Client
            // couldn't be resolved either.
            reason += ' (synthesis attempted but quote.Client.UUID could not be resolved either)';
          }
          errors.push('quote "' + (q?.Name || q?.ID || q?.UUID || '?') + '" skipped: ' + reason);
          continue;
        }
        const r = await upsertQuote(env, q, oppId);
        counts.quotes++;
        // Pull the DetailedQuote and write its Costs/Tasks into
        // quote_lines. Cached so we don't re-fetch when re-importing.
        try {
          const lineCount = await syncQuoteLines(env, r.id, q.UUID, ctx);
          counts.quote_lines += lineCount;
        } catch (lineErr) {
          errors.push('quote-lines ' + (q?.Name || '?') + ': ' + lineErr.message);
        }
        links.push({ url: '/opportunities/' + oppId + '/quotes/' + r.id, label: 'Quote: ' + (q.Name || r.number) });
      } catch (e) { errors.push('quote ' + (q?.Name || '?') + ': ' + e.message); }
    }

    // -------- Jobs ---------
    for (const job of (samples.jobs || [])) {
      try {
        const accountId = job.Client?.UUID
          ? await ensureAccount(env, job.Client.UUID, ctx)
          : null;
        if (!accountId) {
          counts.skipped++;
          errors.push('job "' + (job?.Name || job?.ID || '?') +
            '" skipped: ' +
            (job.Client?.UUID
              ? 'client UUID ' + job.Client.UUID + ' could not be resolved (cascade fetch failed?)'
              : 'no Client.UUID on job'));
          continue;
        }
        const ownerId = job.Manager?.UUID ? userByWfmUuid.get(job.Manager.UUID) : null;
        const o = await upsertOpportunityFromJob(env, job, accountId, ownerId);
        oppByWfmUuid.set(job.UUID, o.id);
        counts.jobs++;
        links.push({ url: '/opportunities/' + o.id, label: 'Job-opp: ' + (job.Name || o.number) });
      } catch (e) { errors.push('job ' + (job?.Name || '?') + ': ' + e.message); }
    }

    const summary =
      counts.accounts + ' accounts'
      + ' · ' + counts.contacts + ' contacts'
      + ' · ' + counts.opportunities + ' opps from leads'
      + ' · ' + counts.quotes + ' quotes (' + counts.quote_lines + ' line items)'
      + ' · ' + counts.jobs + ' opps from jobs'
      + ' · ' + counts.users + ' users enriched'
      + ' · ' + counts.skipped + ' skipped (FK unresolved)'
      + ((counts.accounts_cascaded + counts.contacts_cascaded + counts.opportunities_cascaded) > 0
          ? ' · auto-cascaded: ' + counts.accounts_cascaded + ' accounts, '
            + counts.contacts_cascaded + ' contacts, '
            + counts.opportunities_cascaded + ' opps'
          : '')
      + (counts.opportunities_synthesized > 0
          ? ' · synthesized: ' + counts.opportunities_synthesized + ' orphan-quote opps'
          : '')
      + ((counts.accounts_claimed + counts.contacts_claimed) > 0
          ? ' · claimed (matched existing Pipeline rows by name): '
            + counts.accounts_claimed + ' accounts, '
            + counts.contacts_claimed + ' contacts'
          : '');

    // Cap errors at 50 so the row-size stays bounded in D1; the UI
    // also caps display at 50.
    const cappedErrors = errors.slice(0, 50);
    const cappedLinks  = links.slice(0, 30);

    await recordImportRun(env, {
      id: runId,
      started_at: runStartedAt,
      finished_at: nowIso(),
      triggered_by: triggeredBy,
      ok: true,
      summary,
      counts,
      errors: cappedErrors,
      links: cappedLinks,
      selection_summary: selectionSummary,
      selection_size: selectionSummary.length,
    });

    return json({
      ok: true,
      run_id: runId,
      counts,
      summary,
      links: cappedLinks,
      errors: cappedErrors,
    });
  } catch (err) {
    const fatalMsg = String(err.message || err);
    await recordImportRun(env, {
      id: runId,
      started_at: runStartedAt,
      finished_at: nowIso(),
      triggered_by: triggeredBy,
      ok: false,
      summary: 'fatal: ' + fatalMsg,
      counts,
      errors: errors.concat(['fatal: ' + fatalMsg]).slice(0, 50),
      links: links.slice(0, 30),
      selection_summary: selectionSummary,
      selection_size: selectionSummary.length,
    });
    return json({ ok: false, run_id: runId, error: fatalMsg, counts, links, errors }, 500);
  }
}
