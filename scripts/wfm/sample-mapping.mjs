#!/usr/bin/env node
//
// scripts/wfm/sample-mapping.mjs
//
// Phase 1 sanity-check tool — pulls a small sample of WFM records,
// runs them through the proposed mapping rules from
// docs/wfm-mapping.md, and writes a side-by-side report to
// docs/wfm-mapping-samples.md. NO database writes.
//
// Workflow:
//   1. Run this script.
//   2. Review the output report.
//   3. Edit docs/wfm-mapping.md if anything looks wrong.
//   4. Edit the mappers below to match the doc.
//   5. Re-run.
//   6. Repeat until happy, then build the real importer.
//
// Usage:
//   node scripts/wfm/sample-mapping.mjs
//
// Environment: same .env.local as api-client.mjs and probe.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiGet, getAccessToken, decodeJwtPayload } from './api-client.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const REPORT_PATH = path.join(REPO_ROOT, 'docs', 'wfm-mapping-samples.md');

const SAMPLE_SIZE = 5;

// ---------------------------------------------------------------------
// Lookup tables (would be filled in by the real importer; for the
// sample we just stub them with placeholders so the side-by-side
// reads naturally).
// ---------------------------------------------------------------------

// Maps that the real importer would build:
//   accountByWfmUuid:  WFM Client.UUID  → { id: <pipeline_uuid>, name }
//   contactByWfmUuid:  WFM Contact.UUID → { id: <pipeline_uuid>, name }
//   userByWfmEmail:    WFM Staff.Email  → { id: <pipeline_uuid>, name }
//
// For the sample tool we substitute placeholder text like
//   <pipeline_id_for_account "ROVOP Inc">
// so the report is readable.
function placeholderAccountId(wfmClient) {
  if (!wfmClient) return '<no client on record>';
  return `<pipeline_id_for_account "${wfmClient.Name || wfmClient.UUID}">`;
}
function placeholderContactId(wfmContact) {
  if (!wfmContact) return '<no contact on record>';
  return `<pipeline_id_for_contact "${wfmContact.Name || wfmContact.UUID}">`;
}
function placeholderUserId(wfmStaffOrName) {
  if (!wfmStaffOrName) return '<no owner>';
  const label = typeof wfmStaffOrName === 'string'
    ? wfmStaffOrName
    : (wfmStaffOrName.Name || wfmStaffOrName.Email || wfmStaffOrName.UUID);
  return `<pipeline_id_for_user "${label}">`;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function yesNo(v)  { return /^(yes|true|1)$/i.test(String(v || '').trim()) ? 1 : 0; }
function nowIso()  { return new Date().toISOString(); }

function joinAddress(c) {
  // Build a billing-style address from the discrete WFM Client fields.
  // Uses newlines so address_billing matches Pipeline's convention.
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
  return {
    first_name: trimmed.slice(0, sp),
    last_name:  trimmed.slice(sp + 1).trim(),
  };
}

// ---------------------------------------------------------------------
// Mapping rules (per docs/wfm-mapping.md). Pure functions —
// WFM record → Pipeline row(s).
// ---------------------------------------------------------------------

function mapClient(c) {
  return {
    id:                   '<NEW Pipeline UUID>',
    external_source:      'wfm',
    external_id:          c.UUID,
    name:                 c.Name || '',
    email:                c.Email || '',
    phone:                c.Phone || '',
    fax:                  c.Fax || '',
    website:              c.Website || '',
    address_billing:      joinAddress(c),
    address_physical:     joinPostalAddress(c),
    external_url:         c.WebURL || '',
    account_manager_name: c.AccountManager || '',
    owner_user_id:        c.AccountManager
      ? `<lookup user_id by name '${c.AccountManager}'; null if no match>`
      : '',
    referral_source:      c.ReferralSource || '',
    export_code:          c.ExportCode || '',
    is_archived:          yesNo(c.IsArchived),
    is_prospect:          yesNo(c.IsProspect),
    is_deleted:           yesNo(c.IsDeleted),
    notes:                '',
    created_at:           nowIso(),
    updated_at:           nowIso(),
    wfm_payload:          c,
  };
}

function mapContact(ct, parentClientName) {
  const split = splitName(ct.Name);
  return {
    id:               '<NEW Pipeline UUID>',
    external_source:  'wfm',
    external_id:      ct.UUID,
    account_id:       `<pipeline_id_for_account "${parentClientName}">`,
    first_name:       split.first_name,
    last_name:        split.last_name,
    title:            ct.Position || '',
    email:            ct.Email || '',
    phone:            ct.Phone || '',
    mobile:           ct.Mobile || '',
    is_primary:       yesNo(ct.IsPrimary),
    salutation:       ct.Salutation || '',
    addressee:        ct.Addressee || '',
    notes:            '',
    created_at:       nowIso(),
    updated_at:       nowIso(),
    wfm_payload:      ct,
  };
}

// ---- Stage / category mapping --------------------------------------

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

// "3 Opportunity" / "4 Quoted" / etc. — we pull the trailing word
// after the prefix number to use as a global Category lookup target
// when the lead doesn't carry a Type. As of the probe, leads only
// have a numbered Category; transaction_type comes from the global
// /category.api/list. For sample purposes we default to 'spares'
// when the lead carries no obvious type signal.
function inferTransactionType(_lead, defaultType = 'spares') {
  return defaultType;
}

function buildCategoryNote(rawCategory) {
  const map = CATEGORY_NAME_TO_TYPE[rawCategory];
  if (!map || !map.note) return null;
  return `[WFM] Original category: ${map.note} (mapped → ${map.type}).`;
}

function mapLead(lead) {
  // Stage: derived from Category, then overridden by State if terminal.
  let stage = LEAD_CATEGORY_TO_STAGE[lead.Category] || 'lead';
  if (lead.State === 'Won')  stage = 'won';
  if (lead.State === 'Lost') stage = 'lost';

  return {
    id:                  '<NEW Pipeline UUID>',
    external_source:     'wfm-lead',
    external_id:         lead.UUID,
    title:               lead.Name || '',
    description:         lead.Description || '',
    transaction_type:    inferTransactionType(lead),
    stage,
    wfm_category:        lead.Category || '',
    wfm_type:            '',                       // Lead has no Type (Job does)
    estimated_value_usd: parseFloat(lead.EstimatedValue) || 0,
    expected_close_date: '',                       // not present on Lead
    actual_close_date:   lead.DateWonLost || '',
    account_id:          placeholderAccountId(lead.Client),
    primary_contact_id:  placeholderContactId(lead.Contact),
    owner_user_id:       placeholderUserId(lead.Owner),
    is_hot_sheet:        0,                        // populated from custom-field call
    rfq_received_at:     '',                       // populated from custom-field call
    notes_internal:      '',                       // category-merge note appended at quote time
    external_url:        '',                       // not present on Lead
    created_at:          lead.Date || nowIso(),
    updated_at:          nowIso(),
    wfm_payload:         lead,
  };
}

function mapJob(job) {
  // Type: known WFM categories (NEW EQUIPMENT etc.) — translate via
  // CATEGORY_NAME_TO_TYPE. Generate a notes_internal append if the
  // job has a merged category (SUPPLIES / WARRANTY / etc.).
  const typeMap   = CATEGORY_NAME_TO_TYPE[job.Type] || { type: 'spares', note: null };
  const stage     = JOB_STATE_TO_STAGE[job.State] || 'won';
  const noteLine  = buildCategoryNote(job.Type);

  return {
    id:                      '<NEW Pipeline UUID>',
    external_source:         'wfm-job',
    external_id:             job.UUID,
    title:                   job.Name || '',
    description:             job.Description || '',
    transaction_type:        typeMap.type,
    stage,
    wfm_category:            job.Type || '',
    wfm_type:                job.Type || '',
    estimated_value_usd:     parseFloat(job.Budget) || 0,
    actual_close_date:       job.StartDate || '',
    account_id:              placeholderAccountId(job.Client),
    project_manager_user_id: placeholderUserId(job.Manager),
    salesperson_user_id:     placeholderUserId(job.Partner),
    notes_internal:          noteLine || '',
    external_url:            job.WebURL || '',
    created_at:              job.DateCreatedUtc || nowIso(),
    updated_at:              job.DateModifiedUtc || nowIso(),
    wfm_payload:             job,
    _alsoCreateJobsRow:      !!job.ClientOrderNumber,
    _jobsRow: job.ClientOrderNumber ? {
      external_source:         'wfm-job',
      external_id:             job.UUID,
      job_type:                typeMap.type,
      status:                  ({
        PLANNED: 'created', PRODUCTION: 'handed_off', COMPLETED: 'handed_off', CANCELLED: 'cancelled',
      })[job.State] || 'created',
      title:                   job.Name || '',
      customer_po_number:      job.ClientOrderNumber || '',
      handed_off_at:           job.StartDate || '',
      project_manager_user_id: placeholderUserId(job.Manager),
      external_url:            job.WebURL || '',
      wfm_payload:             job,
    } : null,
  };
}

const QUOTE_STATE_TO_STATUS = {
  Draft:    'draft',
  Issued:   'submitted',
  Accepted: 'accepted',
  Declined: 'rejected',
  Archived: 'expired',
};

function mapQuote(q) {
  return {
    id:                    '<NEW Pipeline UUID>',
    external_source:       'wfm',
    external_id:           q.UUID,
    wfm_number:            q.ID || '',
    wfm_type:              q.Type || '',
    wfm_state:             q.State || '',
    wfm_budget:            q.Budget || '',
    title:                 q.Name || '',
    description:           q.Description || '',
    quote_type:            '<derived from parent opp transaction_type>',
    status:                QUOTE_STATE_TO_STATUS[q.State] || 'draft',
    valid_until:           q.ValidDate || '',
    subtotal_price:        parseFloat(q.Amount) || 0,
    tax_amount:            parseFloat(q.AmountTax) || 0,
    total_price:           parseFloat(q.AmountIncludingTax) || 0,
    notes_customer:        q.OptionExplanation || '',
    notes_internal:        '',
    opportunity_id:        q.LeadUUID
      ? `<pipeline_id_for_opp_with_external_id "${q.LeadUUID}">`
      : (q.JobUUID
          ? `<pipeline_id_for_opp_with_external_id "${q.JobUUID}">`
          : '<no parent opp — orphan>'),
    external_url:          '',
    created_at:             q.Date || nowIso(),
    updated_at:             nowIso(),
    wfm_payload:            q,
    _associatedCostBuild: {
      label:                'WFM-imported estimate',
      total_cost:           parseFloat(q.EstimatedCost) || 0,
      total_cost_source:    'manual',
    },
  };
}

function mapStaff(s) {
  // Lookup-only — does not create a new user, just enriches an
  // existing Pipeline user matched by email.
  return {
    matchOn:          'email',
    matchValue:       (s.Email || '').toLowerCase(),
    enrichments: {
      external_source: 'wfm',
      external_id:     s.UUID,
      external_url:    s.WebURL || '',
      wfm_payload:     s,
      // Pipeline display_name + email come from Cloudflare Access — never overwrite.
      // Phone / Mobile / Address / PayrollCode live in wfm_payload only.
    },
  };
}

// ---------------------------------------------------------------------
// Random sampling
// ---------------------------------------------------------------------

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickDistinct(n, lo, hi) {
  // Pick n distinct integers in [lo, hi] (inclusive). If fewer than n
  // values exist in the range, returns all of them.
  const range = hi - lo + 1;
  const target = Math.min(n, range);
  const set = new Set();
  while (set.size < target) {
    set.add(lo + Math.floor(Math.random() * range));
  }
  return [...set];
}

function joinQuery(basePath, params) {
  const sep = basePath.includes('?') ? '&' : '?';
  return `${basePath}${sep}${params}`;
}

// Probe an endpoint to read TotalRecords from its pagination envelope.
// Returns null if the endpoint doesn't surface a total.
async function readTotalRecords(basePath) {
  const r = await apiGet(joinQuery(basePath, 'page=1&pageSize=1'));
  if (!r.ok) return null;
  const totalStr = r.body?.Response?.TotalRecords;
  if (!totalStr) return null;
  const n = parseInt(totalStr, 10);
  return Number.isNaN(n) ? null : n;
}

// Fetch `count` random records from a list endpoint. Strategy:
//   1. Probe TotalRecords from the pagination envelope.
//   2. Pick `count` distinct random page numbers (treating each
//      page-of-size-1 as one random offset).
//   3. Fetch each and take its first record.
// Falls back to "fetch a chunk and shuffle" for endpoints that don't
// advertise TotalRecords (smaller catalogs like /staff.api/list).
async function fetchRandomSample(basePath, count, primaryKey) {
  const total = await readTotalRecords(basePath);

  if (total === null) {
    // Non-paginated or no TotalRecords surfaced — pull a single page
    // sized larger than `count`, shuffle, take `count`.
    const r = await apiGet(joinQuery(basePath, 'page=1&pageSize=200'));
    const arr = recordArray(r.body, primaryKey);
    return shuffle(arr).slice(0, count);
  }

  if (total <= count) {
    // Fewer records than requested — just return all of them.
    const r = await apiGet(joinQuery(basePath, `page=1&pageSize=${Math.max(total, 1)}`));
    return recordArray(r.body, primaryKey);
  }

  // Pick distinct random page numbers in [1, total].
  const pages = pickDistinct(count, 1, total);
  const records = [];
  for (const page of pages) {
    const r = await apiGet(joinQuery(basePath, `page=${page}&pageSize=1`));
    if (!r.ok) continue;
    const rec = recordArray(r.body, primaryKey, /*singletonFallback*/ true)[0];
    if (rec) records.push(rec);
  }
  return records;
}

// ---------------------------------------------------------------------
// Probe + render
// ---------------------------------------------------------------------

async function fetchSamples() {
  console.log(`  Sampling ${SAMPLE_SIZE} random records per entity…`);

  // Run the four paginated probes in parallel; staff is fetched whole
  // and shuffled (it's only ~30 records).
  const [clientStubs, leads, quotes, jobs, staffList] = await Promise.all([
    fetchRandomSample('/client.api/list', SAMPLE_SIZE, 'Client')
      .then((arr) => { console.log(`    Clients: ${arr.length} sampled`); return arr; }),
    fetchRandomSample('/lead.api/current', SAMPLE_SIZE, 'Lead')
      .then((arr) => { console.log(`    Leads:   ${arr.length} sampled`); return arr; }),
    fetchRandomSample('/quote.api/current', SAMPLE_SIZE, 'Quote')
      .then((arr) => { console.log(`    Quotes:  ${arr.length} sampled`); return arr; }),
    fetchRandomSample('/job.api/current', SAMPLE_SIZE, 'Job')
      .then((arr) => { console.log(`    Jobs:    ${arr.length} sampled`); return arr; }),
    apiGet('/staff.api/list')
      .then((r) => {
        const arr = recordArray(r.body, 'Staff');
        const sampled = shuffle(arr).slice(0, SAMPLE_SIZE);
        console.log(`    Staff:   ${sampled.length} sampled (of ${arr.length} total)`);
        return sampled;
      }),
  ]);

  // For each randomly-sampled client, fetch its detail (so we get
  // Contacts on the response).
  const clientSamples = [];
  for (const c of clientStubs) {
    const detail = await apiGet(`/client.api/get/${c.UUID}`);
    const detailClient = recordArray(detail.body, 'Client', /*singletonFallback*/ true)[0] || c;
    clientSamples.push(detailClient);
  }

  return {
    clients: clientSamples,
    leads,
    quotes,
    jobs,
    staff: staffList,
  };
}

function recordArray(body, primaryKey, treatSingletonAsList = false) {
  // Walk Response → <Plural> → <Singular>[] for the array.
  // Example: body.Response.Clients.Client[] for clients.
  if (!body || typeof body !== 'object') return [];
  const response = body.Response;
  if (!response || typeof response !== 'object') return [];
  for (const v of Object.values(response)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = v[primaryKey];
      if (Array.isArray(inner)) return inner;
      if (inner && typeof inner === 'object') return [inner];
    }
  }
  if (treatSingletonAsList) {
    // Last-ditch: search the response object directly for the singular key.
    if (response[primaryKey]) return [response[primaryKey]];
  }
  return [];
}

function fmtJson(obj) {
  return JSON.stringify(obj, null, 2);
}

function renderSection(title, samples, mapper, kind = 'single') {
  const lines = [];
  lines.push(`## ${title}`);
  lines.push('');
  if (!samples.length) {
    lines.push(`> No samples returned — the endpoint was empty.`);
    lines.push('');
    return lines.join('\n');
  }
  samples.forEach((s, i) => {
    lines.push(`### ${title} sample ${i + 1}`);
    lines.push('');
    lines.push(`<details><summary>WFM source record</summary>`);
    lines.push('');
    lines.push('```json');
    lines.push(fmtJson(s));
    lines.push('```');
    lines.push('');
    lines.push('</details>');
    lines.push('');
    if (kind === 'client_with_contacts') {
      const accountRow = mapClient(s);
      lines.push(`**→ Pipeline accounts row**`);
      lines.push('');
      lines.push('```json');
      lines.push(fmtJson(accountRow));
      lines.push('```');
      lines.push('');
      // Contacts on this client.
      const cts = (s.Contacts && s.Contacts.Contact)
        ? (Array.isArray(s.Contacts.Contact) ? s.Contacts.Contact : [s.Contacts.Contact])
        : [];
      if (cts.length) {
        lines.push(`**→ Pipeline contacts rows (${cts.length})**`);
        lines.push('');
        cts.forEach((ct, ci) => {
          lines.push(`Contact ${ci + 1}:`);
          lines.push('```json');
          lines.push(fmtJson(mapContact(ct, s.Name)));
          lines.push('```');
        });
        lines.push('');
      } else {
        lines.push(`*(no contacts on this client)*`);
        lines.push('');
      }
    } else {
      const out = mapper(s);
      lines.push(`**→ Pipeline ${title.toLowerCase().replace(/s$/, '')} row**`);
      lines.push('');
      lines.push('```json');
      lines.push(fmtJson(out));
      lines.push('```');
      lines.push('');
    }
  });
  return lines.join('\n');
}

async function main() {
  console.log('Fetching WFM samples…');
  const tok = await getAccessToken({ force: true });
  const jwt = decodeJwtPayload(tok);

  const samples = await fetchSamples();

  const sections = [];
  sections.push('# WFM → Pipeline mapping samples');
  sections.push('');
  sections.push(`**Run at:** ${new Date().toISOString()}`);
  sections.push(`**Org:** ${jwt?.org_ids?.[0] || '?'}`);
  sections.push(`**Sample size:** ${SAMPLE_SIZE} random records per entity`);
  sections.push('');
  sections.push(`Each section below picks ${SAMPLE_SIZE} records uniformly at random from the entity's full list (using the TotalRecords envelope to pick distinct random page positions). Re-running the script reshuffles — repeat a few times if you want broader coverage.`);
  sections.push('');
  sections.push('Each section pairs a WFM source record with the Pipeline row(s) it would produce, per the mapping rules in `docs/wfm-mapping.md`. **No database writes happen.** Use this to vet the rules; edit the doc and re-run until the output looks right; then we ship the real importer.');
  sections.push('');
  sections.push('## What to look for');
  sections.push('');
  sections.push('- Are all the WFM fields you care about either ending up in a typed column or in `wfm_payload`?');
  sections.push('- Stage/transaction_type assignments — do the proposed stages make sense for these specific records?');
  sections.push('- For SUPPLIES / WARRANTY / CYLINDERS / REFURB CYLINDERS records: is the `notes_internal` callout the right wording?');
  sections.push('- Quotes: does linking by LeadUUID find the right opp? Any quotes orphaned (no LeadUUID and no JobUUID)?');
  sections.push('- Jobs: which ones get a `jobs` row (i.e. have a ClientOrderNumber)? Anything stuck in `won` that should be `job_in_progress` or vice versa?');
  sections.push('');

  sections.push(renderSection('Clients (with contacts)', samples.clients, mapClient, 'client_with_contacts'));
  sections.push(renderSection('Leads', samples.leads, mapLead));
  sections.push(renderSection('Quotes', samples.quotes, mapQuote));
  sections.push(renderSection('Jobs', samples.jobs, mapJob));
  sections.push(renderSection('Staff', samples.staff, mapStaff));

  fs.writeFileSync(REPORT_PATH, sections.join('\n'));
  console.log(`\nReport written to ${path.relative(REPO_ROOT, REPORT_PATH)}`);
}

main().catch((err) => {
  console.error('Fatal:', err.stack || err.message);
  process.exitCode = 1;
});
