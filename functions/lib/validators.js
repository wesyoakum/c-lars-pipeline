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
 * Validate an opportunity create/update payload.
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

  if (input.rfq_format !== undefined && input.rfq_format !== '') {
    if (!RFQ_FORMATS.has(input.rfq_format)) {
      errors.rfq_format = 'Unknown RFQ format';
    }
    value.rfq_format = input.rfq_format;
  }

  if (input.bant_budget !== undefined && input.bant_budget !== '') {
    if (!BANT_BUDGET.has(input.bant_budget)) {
      errors.bant_budget = 'Must be known, estimated, or unknown';
    }
    value.bant_budget = input.bant_budget;
  }

  value.description = trim(input.description) || null;
  value.estimated_value_usd =
    input.estimated_value_usd === '' || input.estimated_value_usd == null
      ? null
      : Number(input.estimated_value_usd);

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
