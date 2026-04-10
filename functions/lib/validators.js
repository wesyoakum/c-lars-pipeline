// functions/lib/validators.js
//
// Small input validators used by route handlers. These are intentionally
// tiny — no Zod, no Joi — because PMS route handlers are server-rendered
// and the set of fields per form is small. Each validator returns either
// { ok: true, value } or { ok: false, errors: { field: 'message' } }.

const TRANSACTION_TYPES = new Set(['spares', 'eps', 'refurb', 'service']);
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
const PRICING_METHODS = new Set(['bottom_up', 'top_down', 'mixed']);
const TOTAL_COST_SOURCES = new Set(['lines', 'manual']);

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

  value.transaction_type = trim(input.transaction_type);
  if (!TRANSACTION_TYPES.has(value.transaction_type)) {
    errors.transaction_type = 'Must be one of spares, eps, refurb, service';
  }

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

  value.segment = trim(input.segment) || null;
  value.address_billing = trim(input.address_billing) || null;
  value.address_physical = trim(input.address_physical) || null;
  value.phone = trim(input.phone) || null;
  value.website = trim(input.website) || null;
  value.notes = trim(input.notes) || null;
  value.owner_user_id = trim(input.owner_user_id) || null;

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value };
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

export const ENUMS = {
  TRANSACTION_TYPES,
  RFQ_FORMATS,
  SOURCES,
  BANT_BUDGET,
  PRICING_METHODS,
  TOTAL_COST_SOURCES,
  DATE_FIELDS,
};
