// functions/settings/wfm-import/delta/diff.js
//
// Pure-logic module for WFM delta review. No DB dependencies.
//
// Provides:
//   - Field mapping tables per entity type (WFM key → Pipeline column)
//   - Normalizers for consistent comparison
//   - Three-way classify (base / wfm / pipeline → case 1-8)
//   - computeDiff() for generating a full record diff

// ---------- Helpers (mirrored from commit.js) ----------

function s(v) { return v == null ? '' : String(v).trim(); }
function n(v) { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; }
function yesNo(v) { return /^(yes|true|1)$/i.test(String(v || '').trim()) ? 1 : 0; }

function joinAddress(c) {
  return [
    c.Address,
    [c.City, c.Region].filter(Boolean).join(' '),
    [c.PostCode, c.Country].filter(Boolean).join(' '),
  ].filter((p) => p && String(p).trim()).join('\n').trim();
}
function joinPostalAddress(c) {
  return [
    c.PostalAddress,
    [c.PostalCity, c.PostalRegion].filter(Boolean).join(' '),
    [c.PostalPostCode, c.PostalCountry].filter(Boolean).join(' '),
  ].filter((p) => p && String(p).trim()).join('\n').trim();
}

const LEAD_CATEGORY_TO_STAGE = {
  '1 Identified':  'lead',
  '2 Qualifying':  'rfq_received',
  '3 Opportunity': 'quote_drafted',
  '4 Quoted':      'quote_submitted',
  '5 Won':         'won',
  '6 Lost':        'lost',
};

const QUOTE_STATE_TO_STATUS = {
  Draft:    'draft',
  Issued:   'issued',
  Accepted: 'accepted',
  Declined: 'rejected',
  Archived: 'expired',
  Revised:  'revision_draft',
};

const CATEGORY_NAME_TO_TYPE = {
  'NEW EQUIPMENT': 'eps', 'SPARES': 'spares', 'REFURBISHMENT': 'refurb',
  'SERVICE': 'service', 'SUPPLIES': 'spares', 'WARRANTY': 'service',
  'CYLINDERS': 'spares', 'REFURB CYLINDERS': 'refurb',
};

const JOB_STATE_TO_STAGE = {
  PLANNED: 'won', PRODUCTION: 'job_in_progress',
  COMPLETED: 'completed', CANCELLED: 'abandoned',
  ENGINEERING: 'job_in_progress', PROCUREMENT: 'job_in_progress',
  'IN PROGRESS': 'job_in_progress', 'ON ORDER': 'job_in_progress',
  'PREP TO SHIP': 'job_in_progress', SHIPPED: 'job_in_progress',
};

// ---------- Field mapping tables ----------
//
// Each entry: { pipeline, wfm, label, derive?, normalize? }
// - pipeline: column name in the Pipeline table
// - wfm: key in the WFM payload (or null if derived)
// - label: human-readable name for the UI
// - derive: function(payload) → value (for computed fields like address)
// - normalize: normalization function name

export const ACCOUNT_FIELDS = [
  { pipeline: 'name',                 wfm: 'Name',            label: 'Company name' },
  { pipeline: 'email',                wfm: 'Email',           label: 'Email',           normalize: 'email' },
  { pipeline: 'phone',                wfm: 'Phone',           label: 'Phone' },
  { pipeline: 'fax',                  wfm: 'Fax',             label: 'Fax' },
  { pipeline: 'website',              wfm: 'Website',         label: 'Website' },
  { pipeline: 'address_billing',      wfm: null,              label: 'Street address',  derive: joinAddress },
  { pipeline: 'address_physical',     wfm: null,              label: 'Postal address',  derive: joinPostalAddress },
  { pipeline: 'account_manager_name', wfm: 'AccountManager',  label: 'Account manager' },
  { pipeline: 'referral_source',      wfm: 'ReferralSource',  label: 'Referral source' },
  { pipeline: 'export_code',          wfm: 'ExportCode',      label: 'Export code' },
  { pipeline: 'is_archived',          wfm: 'IsArchived',      label: 'Archived',        normalize: 'yesNo' },
  { pipeline: 'is_prospect',          wfm: 'IsProspect',      label: 'Prospect',        normalize: 'yesNo' },
];

export const OPPORTUNITY_FIELDS = [
  { pipeline: 'title',               wfm: 'Name',             label: 'Title' },
  { pipeline: 'description',         wfm: 'Description',      label: 'Description' },
  { pipeline: 'stage',               wfm: null,               label: 'Stage',
    derive: (l) => {
      if (l.State === 'Won') return 'won';
      if (l.State === 'Lost') return 'lost';
      return LEAD_CATEGORY_TO_STAGE[l.Category] || 'lead';
    } },
  { pipeline: 'estimated_value_usd', wfm: 'EstimatedValue',   label: 'Estimated value', normalize: 'money' },
  { pipeline: 'actual_close_date',   wfm: 'DateWonLost',      label: 'Close date' },
  { pipeline: 'wfm_category',        wfm: 'Category',         label: 'WFM category' },
];

export const QUOTE_FIELDS = [
  { pipeline: 'title',          wfm: 'Name',                  label: 'Title' },
  { pipeline: 'description',    wfm: 'Description',           label: 'Description' },
  { pipeline: 'status',         wfm: null,                    label: 'Status',
    derive: (q) => QUOTE_STATE_TO_STATUS[q.State] || 'draft' },
  { pipeline: 'subtotal_price', wfm: 'Amount',                label: 'Subtotal',        normalize: 'money' },
  { pipeline: 'tax_amount',     wfm: 'AmountTax',             label: 'Tax',             normalize: 'money' },
  { pipeline: 'total_price',    wfm: 'AmountIncludingTax',    label: 'Total price',     normalize: 'money' },
  { pipeline: 'valid_until',    wfm: 'ValidDate',             label: 'Valid until' },
  { pipeline: 'notes_customer', wfm: 'OptionExplanation',     label: 'Customer notes' },
  { pipeline: 'wfm_state',     wfm: 'State',                  label: 'WFM state' },
];

export const JOB_FIELDS = [
  { pipeline: 'title',               wfm: 'Name',             label: 'Title' },
  { pipeline: 'job_type',            wfm: null,               label: 'Type',
    derive: (j) => (CATEGORY_NAME_TO_TYPE[j.Type] || { type: 'spares' }).type },
  { pipeline: 'status',              wfm: null,               label: 'Status',
    derive: (j) => ({ PLANNED: 'created', PRODUCTION: 'handed_off', COMPLETED: 'handed_off', CANCELLED: 'cancelled' })[j.State] || 'created' },
  { pipeline: 'customer_po_number',  wfm: 'ClientOrderNumber', label: 'Customer PO' },
  { pipeline: 'wfm_number',          wfm: 'ID',               label: 'WFM number' },
];

const FIELD_MAPS = {
  account:     ACCOUNT_FIELDS,
  opportunity: OPPORTUNITY_FIELDS,
  quote:       QUOTE_FIELDS,
  job:         JOB_FIELDS,
};

export { FIELD_MAPS };

// ---------- Normalizers ----------

const NORMALIZERS = {
  email:     (v) => String(v || '').toLowerCase().trim(),
  yesNo:     (v) => String(yesNo(v)),
  money:     (v) => String(n(v)),
  nullEmpty: (v) => (v == null || String(v).trim() === '') ? '' : String(v).trim(),
};

function norm(value, normName) {
  const fn = normName ? NORMALIZERS[normName] : NORMALIZERS.nullEmpty;
  return fn(value);
}

// ---------- Three-way classify ----------
//
// Returns { case: 1..8 } per docs/wfm-import-review.md §2.
//
// base     = snapshot payload value (null if no snapshot)
// wfm      = freshly fetched WFM value
// pipeline = current Pipeline column value

export function classifyField(base, wfm, pipeline, normalizeName) {
  const w = norm(wfm, normalizeName);
  const p = norm(pipeline, normalizeName);

  if (base == null) {
    // No snapshot — cases 6, 7, 8
    if (p === '' || p == null) return { case: 6 };   // INSERT (Pipeline empty)
    if (p === w) return { case: 7 };                  // match without snapshot
    return { case: 8 };                               // conflict without snapshot
  }

  const b = norm(base, normalizeName);
  if (b === w && b === p) return { case: 1 };         // nothing moved
  if (b === w && b !== p) return { case: 2 };         // Pipeline moved only
  if (b !== w && b === p) return { case: 3 };         // WFM moved only
  if (b !== w && w === p) return { case: 4 };         // both moved to same
  return { case: 5 };                                  // conflict
}

// ---------- Record-level diff ----------

function getWfmValue(field, wfmPayload) {
  if (field.derive) return field.derive(wfmPayload);
  const raw = wfmPayload[field.wfm];
  return raw == null ? '' : String(raw);
}

function getBaseValue(field, snapshotPayload) {
  if (!snapshotPayload) return null;
  if (field.derive) return field.derive(snapshotPayload);
  const raw = snapshotPayload[field.wfm];
  return raw == null ? '' : String(raw);
}

/**
 * Compute a field-by-field diff for one record.
 *
 * @param {string} entityType - 'account' | 'opportunity' | 'quote' | 'job'
 * @param {object} wfmPayload - freshly fetched WFM detail record
 * @param {object|null} pipelineRow - current Pipeline row (null for inserts)
 * @param {object|null} snapshotPayload - last-seen WFM payload (null if no snapshot)
 * @returns {{ diff, hasConflict, hasAutoApply, isInsert, allUnchanged }}
 */
export function computeDiff(entityType, wfmPayload, pipelineRow, snapshotPayload) {
  const fieldMap = FIELD_MAPS[entityType];
  if (!fieldMap) return { diff: {}, hasConflict: false, hasAutoApply: false, isInsert: !pipelineRow, allUnchanged: true };

  const diff = {};
  let hasConflict = false;
  let hasAutoApply = false;
  let allUnchanged = true;
  const isInsert = !pipelineRow;

  for (const field of fieldMap) {
    const wfmValue      = getWfmValue(field, wfmPayload);
    const pipelineValue = pipelineRow ? (pipelineRow[field.pipeline] ?? '') : null;
    const baseValue     = getBaseValue(field, snapshotPayload);

    const classification = classifyField(baseValue, wfmValue, pipelineValue, field.normalize);

    diff[field.pipeline] = {
      label:    field.label,
      base:     baseValue,
      pipeline: pipelineValue,
      wfm:      wfmValue,
      case:     classification.case,
    };

    if (classification.case !== 1 && classification.case !== 4 && classification.case !== 7) {
      allUnchanged = false;
    }
    if (classification.case === 5 || classification.case === 8) hasConflict = true;
    if (classification.case === 3) hasAutoApply = true;
  }

  return { diff, hasConflict, hasAutoApply, isInsert, allUnchanged };
}

/**
 * Get a display name for a WFM record (for the review UI).
 */
export function displayName(entityType, wfmPayload) {
  switch (entityType) {
    case 'account':     return s(wfmPayload.Name);
    case 'opportunity': return s(wfmPayload.Name);
    case 'quote':       return (wfmPayload.ID ? wfmPayload.ID + ' — ' : '') + s(wfmPayload.Name);
    case 'job':         return (wfmPayload.ID ? wfmPayload.ID + ' — ' : '') + s(wfmPayload.Name);
    default:            return s(wfmPayload.Name || wfmPayload.ID || wfmPayload.UUID || '?');
  }
}
