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
const BANT_BUDGET = new Set(['known', 'estimated', 'unknown']);
const PRICING_METHODS = new Set(['bottom_up', 'top_down', 'mixed']);
const TOTAL_COST_SOURCES = new Set(['lines', 'manual']);

function nonEmpty(v) {
  return v !== undefined && v !== null && String(v).trim() !== '';
}

function trim(v) {
  return typeof v === 'string' ? v.trim() : v;
}

/**
 * Validate an opportunity create/update payload. Covers every field the
 * M3 forms expose (title, account, type, rfq_format, BANT, estimated
 * value, expected close, primary contact, owner/salesperson). Stage
 * transitions go through validateStageTransition below — this function
 * never mutates stage.
 */
export function validateOpportunity(input) {
  const errors = {};
  const value = {};

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

  // Expected close date: optional ISO date (YYYY-MM-DD).
  const ecd = trim(input.expected_close_date);
  if (!ecd) {
    value.expected_close_date = null;
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(ecd)) {
    errors.expected_close_date = 'Use YYYY-MM-DD';
    value.expected_close_date = null;
  } else {
    value.expected_close_date = ecd;
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

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value };
}

/**
 * Validate a contact create/update payload.
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
  value.is_primary = input.is_primary ? 1 : 0;

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value };
}

export const ENUMS = {
  TRANSACTION_TYPES,
  RFQ_FORMATS,
  BANT_BUDGET,
  PRICING_METHODS,
  TOTAL_COST_SOURCES,
};
