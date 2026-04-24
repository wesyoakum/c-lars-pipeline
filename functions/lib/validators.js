// functions/lib/validators.js
//
// Small input validators used by route handlers. These are intentionally
// tiny — no Zod, no Joi — because PMS route handlers are server-rendered
// and the set of fields per form is small. Each validator returns either
// { ok: true, value } or { ok: false, errors: { field: 'message' } }.

const TRANSACTION_TYPES = new Set(['spares', 'eps', 'refurb', 'service']);

/**
 * Parse a (possibly comma-separated) transaction_type string into an
 * array of individual types.  e.g. "spares,service" → ['spares','service']
 */
export function parseTransactionTypes(raw) {
  if (!raw) return [];
  return String(raw).split(',').map(t => t.trim()).filter(Boolean);
}
const RFQ_FORMATS = new Set([
  'verbal',
  'text',
  'email_informal',
  'email_formal',
  'formal_document',
  'government_rfq',
  'rfi_preliminary',
  'none',
  'other',
]);
const SOURCES = new Set(['inbound', 'outreach', 'referral', 'existing', 'other']);
const BANT_BUDGET = new Set(['known', 'estimated', 'unknown']);
// Cost-build statuses (migration 0005 — calculator-model price builds).
const COST_BUILD_STATUSES = new Set(['draft', 'locked']);

// Workcenters for labor entries. Mirrors the seed value in
// pricing_settings.workcenters; kept as a JS-side fallback so validators
// don't need to hit D1 just to sanity-check a form field.
const DEFAULT_WORKCENTERS = new Set([
  'Fab', 'Paint', 'Mechanical', 'Electrical', 'Hydraulic', 'Testing', 'Engineering',
]);

// All four pipeline date fields the opportunity form exposes. Stored as
// ISO YYYY-MM-DD strings; null means "not yet set".
const DATE_FIELDS = [
  'expected_close_date',
  'rfq_received_date',
  'rfq_due_date',
  'rfi_due_date',
  'quoted_date',
];

function nonEmpty(v) {
  return v !== undefined && v !== null && String(v).trim() !== '';
}

function trim(v) {
  return typeof v === 'string' ? v.trim() : v;
}

/**
 * Derive a conversational alias from a legal account name by stripping
 * trailing corporate suffixes (", LLC", ", Inc.", ", Ltd.", etc.).
 *
 *   deriveAlias('Helix Robotics, Inc.')   // 'Helix Robotics'
 *   deriveAlias('Acme Co.')               // 'Acme'
 *   deriveAlias('  Big Industries LLC ')  // 'Big Industries'
 *   deriveAlias('')                       // ''
 *
 * Used by validateAccount() when the caller doesn't supply an explicit
 * alias, and by migration 0033 to backfill existing accounts.
 */
export function deriveAlias(name) {
  if (!nonEmpty(name)) return '';
  let s = String(name).trim();
  // Strip well-known corporate suffixes from the end. Allow optional
  // leading comma + whitespace, optional trailing period. Run repeatedly
  // so "Foo, Inc., LLC" collapses cleanly. Case-insensitive.
  const suffixRe = /[,\s]+(L\.?L\.?C\.?|L\.?L\.?P\.?|L\.?P\.?|Inc\.?|Incorporated|Co\.?|Corp\.?|Corporation|Ltd\.?|Limited|GmbH|S\.?A\.?|N\.?V\.?|P\.?L\.?L\.?C\.?|P\.?C\.?)\.?$/i;
  for (let i = 0; i < 4; i++) {
    const next = s.replace(suffixRe, '').trim();
    if (next === s) break;
    s = next;
  }
  // Drop a trailing comma left behind by a stripped suffix (e.g.
  // "Acme Co.," → "Acme Co" → "Acme,") — clean it up.
  s = s.replace(/[,\s]+$/, '');
  return s;
}

/**
 * Validate an opportunity create/update payload. Covers every field the
 * forms expose: identity (number, title, account, type), pipeline dates
 * (rfq_received, rfq_due, rfi_due, expected_close, quoted), routing
 * (rfq_format, source), BANT-lite, value/probability, ownership, and
 * primary contact. Stage transitions go through validateStageTransition
 * below — this function never mutates stage.
 *
 * `number` is optional on create (auto-allocated server-side when blank)
 * but editable on update. Uniqueness is enforced by the UNIQUE index on
 * `opportunities.number`; collisions surface as a normal SQL error which
 * the route handler catches and turns into `errors.number`.
 */
export function validateOpportunity(input) {
  const errors = {};
  const value = {};

  // Number: optional. Empty/whitespace => null (let the route auto-allocate).
  // When present, must look like a small positive integer (digits only,
  // 1..10 chars). We don't enforce 5 digits because the user may want to
  // type a shorter or longer one.
  const rawNum = trim(input.number);
  if (rawNum == null || rawNum === '') {
    value.number = null;
  } else if (!/^\d{1,10}$/.test(String(rawNum))) {
    errors.number = 'Number must be digits only';
    value.number = null;
  } else {
    value.number = String(rawNum);
  }

  value.title = trim(input.title);
  if (!nonEmpty(value.title)) errors.title = 'Title is required';

  value.account_id = trim(input.account_id);
  if (!nonEmpty(value.account_id)) errors.account_id = 'Account is required';

  // transaction_type accepts comma-separated values (e.g. "spares,service")
  const rawType = trim(input.transaction_type);
  const types = parseTransactionTypes(rawType);
  if (types.length === 0) {
    errors.transaction_type = 'At least one type is required';
  } else {
    const invalid = types.filter(t => !TRANSACTION_TYPES.has(t));
    if (invalid.length > 0) {
      errors.transaction_type = `Unknown type(s): ${invalid.join(', ')}`;
    }
  }
  value.transaction_type = types.length > 0 ? types.join(',') : null;

  // Optional: RFQ format. Empty string means "not specified" and we store null.
  if (input.rfq_format === undefined || input.rfq_format === '' || input.rfq_format === null) {
    value.rfq_format = null;
  } else if (!RFQ_FORMATS.has(input.rfq_format)) {
    errors.rfq_format = 'Unknown RFQ format';
  } else {
    value.rfq_format = input.rfq_format;
  }

  // Optional: source — how the deal landed in our pipeline.
  if (input.source === undefined || input.source === '' || input.source === null) {
    value.source = null;
  } else if (!SOURCES.has(input.source)) {
    errors.source = 'Unknown source';
  } else {
    value.source = input.source;
  }

  // BANT-lite
  if (input.bant_budget === undefined || input.bant_budget === '' || input.bant_budget === null) {
    value.bant_budget = null;
  } else if (!BANT_BUDGET.has(input.bant_budget)) {
    errors.bant_budget = 'Must be known, estimated, or unknown';
  } else {
    value.bant_budget = input.bant_budget;
  }
  // Authority is now a contact reference (bant_authority_contact_id).
  // The old free-text bant_authority column is kept as a fallback for
  // cases where the user hasn't yet picked / created a contact.
  value.bant_authority_contact_id = trim(input.bant_authority_contact_id) || null;
  value.bant_authority = trim(input.bant_authority) || null;
  value.bant_need = trim(input.bant_need) || null;
  value.bant_timeline = trim(input.bant_timeline) || null;

  value.description = trim(input.description) || null;

  // Estimated value: optional, must be a finite non-negative number if present.
  if (input.estimated_value_usd === '' || input.estimated_value_usd == null) {
    value.estimated_value_usd = null;
  } else {
    const n = Number(input.estimated_value_usd);
    if (!Number.isFinite(n) || n < 0) {
      errors.estimated_value_usd = 'Estimated value must be a non-negative number';
      value.estimated_value_usd = null;
    } else {
      value.estimated_value_usd = n;
    }
  }

  // Probability: optional manual override (0..100 integer). Default-from-stage
  // logic lives in the route handler — this validator only sanity-checks
  // whatever the user typed.
  if (input.probability === '' || input.probability == null) {
    value.probability = null;
  } else {
    const p = Number(input.probability);
    if (!Number.isFinite(p) || p < 0 || p > 100) {
      errors.probability = 'Probability must be 0–100';
      value.probability = null;
    } else {
      value.probability = Math.round(p);
    }
  }

  // All five date fields: optional ISO YYYY-MM-DD.
  for (const f of DATE_FIELDS) {
    const v = trim(input[f]);
    if (!v) {
      value[f] = null;
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      errors[f] = 'Use YYYY-MM-DD';
      value[f] = null;
    } else {
      value[f] = v;
    }
  }

  // Optional ID references — stored as-is if present, otherwise null.
  value.primary_contact_id = trim(input.primary_contact_id) || null;
  value.owner_user_id = trim(input.owner_user_id) || null;
  value.salesperson_user_id = trim(input.salesperson_user_id) || null;

  // Customer PO number — free text, required for Closed Won gate check.
  value.customer_po_number = trim(input.customer_po_number) || null;

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value };
}

/**
 * Validate a stage-transition payload. Only checks the shape — the
 * transaction-type-aware "is this stage legal for this opp" check
 * belongs in the route handler (it needs the opportunity row). Gate
 * rule evaluation lives in lib/stages.js and is deferred to M7.
 */
export function validateStageTransition(input) {
  const errors = {};
  const value = {};

  value.to_stage = trim(input.to_stage);
  if (!nonEmpty(value.to_stage)) errors.to_stage = 'Target stage is required';

  value.override_reason = trim(input.override_reason) || null;
  value.close_reason = trim(input.close_reason) || null;
  value.loss_reason_tag = trim(input.loss_reason_tag) || null;

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value };
}

/**
 * Validate an account create/update payload.
 */
export function validateAccount(input) {
  const errors = {};
  const value = {};

  value.name = trim(input.name);
  if (!nonEmpty(value.name)) errors.name = 'Name is required';

  // Alias defaults to the name with the corporate suffix stripped
  // (", LLC" / ", Inc." / etc.) so list views show the conversational
  // name instead of the legal name. Only applied when the caller didn't
  // supply an explicit alias. Migration 0034 guarantees alias is never
  // null/empty so the per-user "Show aliases" toggle never produces a
  // blank cell — if both the explicit alias and the derived alias are
  // empty we fall back to the raw name.
  const rawAlias = trim(input.alias);
  const derived = deriveAlias(value.name);
  value.alias = nonEmpty(rawAlias)
    ? rawAlias
    : (nonEmpty(derived) ? derived : (value.name || null));

  value.segment = trim(input.segment) || null;
  value.address_billing = trim(input.address_billing) || null;
  value.address_physical = trim(input.address_physical) || null;
  value.phone = trim(input.phone) || null;
  value.website = trim(input.website) || null;
  value.notes = trim(input.notes) || null;
  value.owner_user_id = trim(input.owner_user_id) || null;

  // Active/Inactive flag (migration 0030). Accepts the string values
  // 'active' / 'inactive' from selects, plain 0/1, or the legacy
  // checkbox-ish 'on'/'off'. Default: active. The column is NOT NULL
  // so we always produce a 0 or 1 — never null.
  value.is_active = parseIsActive(input.is_active);

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value };
}

/**
 * Coerce an is_active form value to the 0|1 the DB column stores.
 * Accepts 'active'/'inactive', 0/1, '0'/'1', true/false, 'on'/'off',
 * and undefined (defaults to 1 = active).
 */
export function parseIsActive(raw) {
  if (raw === undefined || raw === null || raw === '') return 1;
  if (raw === 'inactive' || raw === 0 || raw === '0' || raw === false || raw === 'false' || raw === 'off') {
    return 0;
  }
  return 1;
}

/**
 * Validate a contact create/update payload. `account_id` is editable
 * (so a contact can be moved between accounts) but is still required —
 * a contact must always belong to some account.
 */
export function validateContact(input) {
  const errors = {};
  const value = {};

  value.account_id = trim(input.account_id);
  if (!nonEmpty(value.account_id)) errors.account_id = 'Account is required';

  value.first_name = trim(input.first_name) || null;
  value.last_name = trim(input.last_name) || null;
  if (!value.first_name && !value.last_name) {
    errors.name = 'First or last name is required';
  }

  value.title = trim(input.title) || null;
  value.email = trim(input.email) || null;
  value.phone = trim(input.phone) || null;
  value.mobile = trim(input.mobile) || null;
  value.notes = trim(input.notes) || null;
  value.is_primary = input.is_primary ? 1 : 0;

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value };
}

// ---------------------------------------------------------------------
// Cost-build / library validators (M4 — calculator-model pricing)
// ---------------------------------------------------------------------

/**
 * Parse an optional dollar-ish input into a number-or-null. Accepts
 * '', null, undefined, '$12,345.67', '12345.67' etc. Returns
 *   { value: number|null, error: string|null }.
 * Empty means "user hasn't typed anything" (null, which is meaningful
 * for the auto-fill engine — it triggers the estimate).
 */
function parseOptionalMoney(raw) {
  if (raw === undefined || raw === null) return { value: null, error: null };
  const s = String(raw).trim();
  if (s === '') return { value: null, error: null };
  const cleaned = s.replace(/[$,\s]/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return { value: null, error: 'Must be a number' };
  if (n < 0) return { value: null, error: 'Must be zero or positive' };
  return { value: n, error: null };
}

/**
 * Parse an optional non-negative number (hours, rate, etc.).
 */
function parseOptionalNumber(raw) {
  if (raw === undefined || raw === null) return { value: null, error: null };
  const s = String(raw).trim();
  if (s === '') return { value: null, error: null };
  const n = Number(s.replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) return { value: null, error: 'Must be a number' };
  if (n < 0) return { value: null, error: 'Must be zero or positive' };
  return { value: n, error: null };
}

/**
 * Validate a cost_builds create/update payload. All four cost inputs
 * and the quote price are *optional* — nullable means "user has not set
 * a value" which is meaningful to the pricing engine (it auto-fills).
 *
 * Library linkage toggles (use_dm_library / use_labor_library) are
 * booleans represented as 0/1 in the DB.
 */
export function validateCostBuild(input) {
  const errors = {};
  const value = {};

  value.label = trim(input.label) || null;
  value.notes = trim(input.notes) || null;

  // Four cost categories
  for (const [field, key] of [
    ['dm_user_cost',    'dm_user_cost'],
    ['dl_user_cost',    'dl_user_cost'],
    ['imoh_user_cost',  'imoh_user_cost'],
    ['other_user_cost', 'other_user_cost'],
    ['quote_price_user','quote_price_user'],
  ]) {
    const { value: n, error } = parseOptionalMoney(input[field]);
    if (error) errors[key] = error;
    value[key] = n;
  }

  // Library linkage toggles — checkboxes arrive as 'on' or undefined.
  value.use_dm_library    = input.use_dm_library    ? 1 : 0;
  value.use_labor_library = input.use_labor_library ? 1 : 0;

  // T3.2 Phase 3 — build-level discount. Mirrors the validateQuoteLine
  // discount parsing: amount wins over pct, phantom means "display only".
  // When a build has a discount AND is linked to a line, the patch
  // handler flows these values down onto the quote_line at autosave time.
  const { value: discAmt, error: discAmtErr } = parseOptionalMoney(input.discount_amount);
  if (discAmtErr) errors.discount_amount = discAmtErr;
  value.discount_amount = discAmt === null ? null : discAmt;

  const { value: discPct, error: discPctErr } = parseOptionalNumber(input.discount_pct);
  if (discPctErr) errors.discount_pct = discPctErr;
  if (discPct != null && (discPct < 0 || discPct > 100)) {
    errors.discount_pct = 'Discount percent must be between 0 and 100';
  }
  value.discount_pct = discPct === null ? null : discPct;

  value.discount_description = trim(input.discount_description) || null;
  value.discount_is_phantom =
    input.discount_is_phantom === '1' ||
    input.discount_is_phantom === 'on' ||
    input.discount_is_phantom === 1 ||
    input.discount_is_phantom === true
      ? 1
      : 0;

  // Status is not user-editable through this validator — lock/unlock
  // endpoints set it directly. We leave it out of `value` so a caller
  // running an UPDATE won't accidentally clobber it.

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value };
}

/**
 * Validate a dm_items (library) create/update payload.
 */
export function validateDmItem(input) {
  const errors = {};
  const value = {};

  value.description = trim(input.description) || '';
  if (!nonEmpty(value.description)) {
    errors.description = 'Description is required';
  }

  const { value: cost, error: costErr } = parseOptionalMoney(input.cost);
  if (costErr) errors.cost = costErr;
  // dm_items.cost NOT NULL DEFAULT 0 — coerce null to 0 on save.
  value.cost = cost === null ? 0 : cost;

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value };
}

/**
 * Validate a labor_items (library) create/update payload. This only
 * covers the header row (description). The per-workcenter hours/rate
 * entries are validated separately via validateWorkcenterEntries().
 */
export function validateLaborItem(input) {
  const errors = {};
  const value = {};

  value.description = trim(input.description) || '';
  if (!nonEmpty(value.description)) {
    errors.description = 'Description is required';
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value };
}

/**
 * Validate a set of workcenter entries posted as parallel form fields:
 *   hours[Fab], hours[Paint], ...   rate[Fab], rate[Paint], ...
 *
 * Returns:
 *   { ok: true, value: [{ workcenter, hours, rate }] }
 * Workcenters with hours===null AND rate===null are dropped (meaning
 * "leave blank" / "delete this row"). Workcenters with hours=0 are kept
 * only if rate is non-null (so users can pre-populate a rate). Rows
 * where only the rate is set are dropped — they have no labor cost
 * impact on their own.
 *
 * `workcenters` is the authoritative list from pricing_settings; any
 * key outside this list is silently ignored (defense against injected
 * form fields).
 */
export function validateWorkcenterEntries(hoursMap, rateMap, workcenters) {
  const errors = {};
  const value = [];
  const allowed = new Set(workcenters || Array.from(DEFAULT_WORKCENTERS));

  for (const wc of allowed) {
    const hoursRaw = hoursMap ? hoursMap[wc] : undefined;
    const rateRaw  = rateMap  ? rateMap[wc]  : undefined;

    const hRes = parseOptionalNumber(hoursRaw);
    const rRes = parseOptionalNumber(rateRaw);

    if (hRes.error) errors[`hours_${wc}`] = hRes.error;
    if (rRes.error) errors[`rate_${wc}`]  = rRes.error;

    // Drop rows with no hours — pricing engine treats missing
    // workcenters as zero anyway, and we don't want orphaned rate-only
    // rows polluting cost_build_labor.
    if (hRes.value === null) continue;
    value.push({
      workcenter: wc,
      hours: hRes.value,
      rate:  rRes.value,   // null → use default rate at compute time
    });
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value };
}

// ---------------------------------------------------------------------
// Quote validators (M5)
// ---------------------------------------------------------------------

// Allowed quote_type values per opportunity transaction_type. A plain
// Spares/EPS/Service deal has a single matching type; Refurb allows
// baseline and modified. Supplemental quotes were removed in
// migration 0045 — any mid-job scope change now happens via a Change
// Order (see `change_orders` table), whose quotes reuse these same
// types plus a change_order_id FK.
const QUOTE_TYPES_BY_TRANSACTION = {
  spares:  ['spares'],
  eps:     ['eps'],
  service: ['service'],
  refurb:  ['refurb_baseline', 'refurb_modified'],
};
const ALL_QUOTE_TYPES = new Set(
  Object.values(QUOTE_TYPES_BY_TRANSACTION).flat()
);

const QUOTE_STATUSES = new Set([
  'draft',
  'issued',
  'revision_draft',
  'revision_issued',
  'accepted',
  'rejected',
  'expired',
  'dead',
]);

const QUOTE_LINE_ITEM_TYPES = new Set(['product', 'service', 'labor', 'misc']);

/**
 * Return the allowed quote_type values for a given opportunity
 * transaction_type (which may be comma-separated for multi-type opps).
 * Used by the quote create form to render the picker.
 */
export function allowedQuoteTypes(transactionType) {
  const types = parseTransactionTypes(transactionType);
  if (types.length === 0) return [];
  const merged = [];
  const seen = new Set();
  for (const t of types) {
    for (const qt of (QUOTE_TYPES_BY_TRANSACTION[t] ?? [])) {
      if (!seen.has(qt)) { seen.add(qt); merged.push(qt); }
    }
  }
  return merged;
}

/**
 * Human-readable labels for quote_type keys.
 */
export const QUOTE_TYPE_LABELS = {
  spares:               'Spares',
  eps:                  'EPS',
  refurb_baseline:      'Refurb – Base',
  refurb_modified:      'Refurb – Mod',
  service:              'Service',
};

/**
 * T3.4 Sub-feature A — Hybrid quotes.
 *
 * A hybrid quote's `quote_type` column holds a comma-separated list of
 * parts (e.g. "spares,service"). These helpers mirror the pattern
 * already in use for opportunity `transaction_type` via
 * parseTransactionTypes().
 *
 * Single-type quotes return a one-element array — callers that want to
 * branch on "is this hybrid" should use isHybridQuote(). Callers that
 * just need a single value for a legacy single-type routing path
 * (e.g. stage lookup by primary type) can use primaryQuoteType().
 */
export function parseQuoteTypes(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map(t => String(t || '').trim()).filter(Boolean);
  }
  return String(raw).split(',').map(t => t.trim()).filter(Boolean);
}

export function isHybridQuote(raw) {
  return parseQuoteTypes(raw).length > 1;
}

export function primaryQuoteType(raw) {
  return parseQuoteTypes(raw)[0] ?? null;
}

/**
 * Display label for a (possibly hybrid) quote_type value. Single-type
 * falls back to QUOTE_TYPE_LABELS directly; hybrid joins the labels
 * with " + " (e.g. "Spares + Service").
 */
export function quoteTypeDisplayLabel(raw) {
  const parts = parseQuoteTypes(raw);
  if (parts.length === 0) return '';
  return parts.map(p => QUOTE_TYPE_LABELS[p] ?? p).join(' + ');
}

/**
 * Human-readable labels for quote status keys.
 */
export const QUOTE_STATUS_LABELS = {
  draft:            'Draft',
  issued:           'Issued',
  revision_draft:   'Revision Draft',
  revision_issued:  'Revision Issued',
  accepted:         'Accepted',
  rejected:         'Rejected',
  expired:          'Expired',
  dead:             'Dead',
};

/**
 * Validate a quote create/update payload. `transactionType` is the
 * parent opportunity's transaction_type — it constrains the allowed
 * quote_type values. Pass `null` on update to skip the constraint check
 * (the DB already stores a valid value).
 *
 * Lines are validated separately via validateQuoteLine().
 */
export function validateQuote(input, { transactionType = null, requireType = true } = {}) {
  const errors = {};
  const value = {};

  value.title = trim(input.title) || null;
  value.description = trim(input.description) || null;

  // quote_type is required at create time (we need to know which flavor
  // of quote we're minting) but immutable on update — the route handler
  // drops it from the update payload, so on update we pass requireType=false.
  //
  // T3.4 Sub-feature A — accepts either a single string ("spares"),
  // a comma-separated string ("spares,service"), or an array of parts
  // (from multiple same-named checkboxes in the create form). The
  // canonical stored form is comma-separated with duplicates stripped
  // in first-seen order.
  if (requireType) {
    const parts = parseQuoteTypes(input.quote_type);
    if (parts.length === 0) {
      errors.quote_type = 'Quote type is required';
      value.quote_type = null;
    } else {
      const unknown = parts.find(p => !ALL_QUOTE_TYPES.has(p));
      if (unknown) {
        errors.quote_type = `Unknown quote type: ${unknown}`;
        value.quote_type = null;
      } else if (transactionType) {
        const allowed = allowedQuoteTypes(transactionType);
        const bad = parts.find(p => !allowed.includes(p));
        if (bad) {
          errors.quote_type =
            `"${QUOTE_TYPE_LABELS[bad] ?? bad}" is not valid for this opportunity's type(s)`;
          value.quote_type = null;
        }
      }
      if (!errors.quote_type) {
        // Canonicalize: dedupe, preserve first-seen order.
        const seen = new Set();
        const canonical = [];
        for (const p of parts) {
          if (!seen.has(p)) { seen.add(p); canonical.push(p); }
        }
        value.quote_type = canonical.join(',');
      }
    }
  }

  // Validity / terms / delivery — all optional free-text or ISO-date.
  const validUntil = trim(input.valid_until);
  if (!validUntil) {
    value.valid_until = null;
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) {
    errors.valid_until = 'Use YYYY-MM-DD';
    value.valid_until = null;
  } else {
    value.valid_until = validUntil;
  }

  value.incoterms         = trim(input.incoterms) || null;
  value.payment_terms     = trim(input.payment_terms) || null;
  value.delivery_terms    = trim(input.delivery_terms) || null;
  value.delivery_estimate = trim(input.delivery_estimate) || null;

  value.notes_internal = trim(input.notes_internal) || null;
  value.notes_customer = trim(input.notes_customer) || null;

  // Tax amount (optional — defaults to 0 on save). Subtotal and total
  // are derived from the lines server-side, never accepted from the form.
  const { value: tax, error: taxErr } = parseOptionalMoney(input.tax_amount);
  if (taxErr) errors.tax_amount = taxErr;
  value.tax_amount = tax === null ? 0 : tax;

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value };
}

/**
 * Validate a single quote_line create/update payload. Line totals are
 * computed server-side as quantity * unit_price.
 */
export function validateQuoteLine(input) {
  const errors = {};
  const value = {};

  // Title/part number (new field) — optional
  value.title = trim(input.title) || null;
  value.part_number = trim(input.part_number) || null;

  value.description = trim(input.description) || '';
  // Description is no longer required if title is provided
  if (!nonEmpty(value.description) && !nonEmpty(value.title)) {
    errors.description = 'Description or title is required';
  }

  const itemType = trim(input.item_type) || 'product';
  if (!QUOTE_LINE_ITEM_TYPES.has(itemType)) {
    errors.item_type = 'Unknown item type';
    value.item_type = 'product';
  } else {
    value.item_type = itemType;
  }

  // Quantity: optional, defaults to 1.
  const { value: qty, error: qtyErr } = parseOptionalNumber(input.quantity);
  if (qtyErr) errors.quantity = qtyErr;
  value.quantity = qty === null ? 1 : qty;

  value.unit = trim(input.unit) || 'ea';

  // Unit price: optional, defaults to 0.
  const { value: price, error: priceErr } = parseOptionalMoney(input.unit_price);
  if (priceErr) errors.unit_price = priceErr;
  value.unit_price = price === null ? 0 : price;

  value.notes = trim(input.notes) || null;
  value.line_notes = trim(input.line_notes) || null;

  // Option flag: line item priced but not included in quote total
  value.is_option = input.is_option === '1' || input.is_option === 'on' ? 1 : 0;

  // T3.4 Sub-feature A — line_type tags a line with which sub-type of
  // a hybrid quote it belongs to. Optional; null on single-type quotes
  // and on unassigned lines in a hybrid. The route handler is
  // responsible for checking that the chosen part actually belongs to
  // the parent quote's `quote_type` parts — we can't validate that
  // here without a DB lookup.
  const lt = trim(input.line_type);
  if (!lt) {
    value.line_type = null;
  } else if (!ALL_QUOTE_TYPES.has(lt)) {
    errors.line_type = 'Unknown section';
    value.line_type = null;
  } else {
    value.line_type = lt;
  }

  // T3.2 Phase 2 — per-line discount. Same semantics as header discount
  // (see pricing.js): amount wins over pct, phantom means "display only,
  // don't reduce stored totals".
  const { value: discAmt, error: discAmtErr } = parseOptionalMoney(input.discount_amount);
  if (discAmtErr) errors.discount_amount = discAmtErr;
  value.discount_amount = discAmt === null ? null : discAmt;

  const { value: discPct, error: discPctErr } = parseOptionalNumber(input.discount_pct);
  if (discPctErr) errors.discount_pct = discPctErr;
  if (discPct != null && (discPct < 0 || discPct > 100)) {
    errors.discount_pct = 'Discount percent must be between 0 and 100';
  }
  value.discount_pct = discPct === null ? null : discPct;

  value.discount_description = trim(input.discount_description) || null;
  value.discount_is_phantom =
    input.discount_is_phantom === '1' ||
    input.discount_is_phantom === 'on' ||
    input.discount_is_phantom === 1 ||
    input.discount_is_phantom === true
      ? 1
      : 0;

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value };
}

export const ENUMS = {
  TRANSACTION_TYPES,
  RFQ_FORMATS,
  SOURCES,
  BANT_BUDGET,
  COST_BUILD_STATUSES,
  DEFAULT_WORKCENTERS,
  DATE_FIELDS,
  QUOTE_STATUSES,
  QUOTE_LINE_ITEM_TYPES,
  QUOTE_TYPES_BY_TRANSACTION,
  ALL_QUOTE_TYPES,
};
