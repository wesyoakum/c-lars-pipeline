// functions/settings/auto-tasks/rule-schema.js
//
// Per-trigger hint data that the rule-builder UI uses to populate
// dropdowns instead of asking users to remember dotted payload paths.
//
// Each entry describes the payload shape the engine passes to
// fireEvent() for that trigger — see functions/lib/auto-tasks.js for
// the authoritative definition. If a new trigger is added, extend
// these maps and the TRIGGERS export in ../index.js.
//
// CONDITION_PATHS[trigger]  — fields that are sensible to condition on
// TOKEN_PATHS[trigger]      — fields that are sensible to substitute in
//                              task title / body via {path.to.value}
// STAGE_KEYS                — known opportunity stages, for select values
// TRANSACTION_TYPES         — known opportunity transaction_type values
// QUOTE_TYPES               — known quote quote_type values
// ERROR_CODES               — known error.code values for system.error
// ASSIGNEE_OPTIONS          — assignee selector presets
// LINK_OPTIONS              — link selector options

// Re-used quote-scoped condition set (quote.issued / accepted / rejected /
// expired / revised all carry the same {quote, opportunity, account}
// payload shape via auto-tasks.js).
const QUOTE_CONDITIONS = [
  { path: 'quote.quote_type',             label: 'Quote type',              values: 'quote_types' },
  { path: 'quote.status',                 label: 'Quote status' },
  { path: 'quote.is_hybrid',              label: 'Is hybrid quote?',        values: ['1', '0'] },
  { path: 'opportunity.stage',            label: 'Opportunity stage',       values: 'stages' },
  { path: 'opportunity.transaction_type', label: 'Opportunity type',        values: 'transaction_types' },
  { path: 'opportunity.owner_user_id',    label: 'Opportunity owner (user id)' },
  { path: 'account.name',                 label: 'Account name' },
];

// Re-used job-scoped condition set (oc.issued / ntp.issued /
// authorization.received / job.handed_off / job.completed).
const JOB_CONDITIONS = [
  { path: 'job.status',                   label: 'Job status' },
  { path: 'job.oc_number',                label: 'OC number' },
  { path: 'opportunity.stage',            label: 'Opportunity stage',       values: 'stages' },
  { path: 'opportunity.transaction_type', label: 'Opportunity type',        values: 'transaction_types' },
  { path: 'opportunity.owner_user_id',    label: 'Opportunity owner (user id)' },
  { path: 'account.name',                 label: 'Account name' },
];

export const CONDITION_PATHS = {
  // Quote lifecycle — inline triggers
  'quote.issued':        QUOTE_CONDITIONS,
  'quote.accepted':      QUOTE_CONDITIONS,
  'quote.rejected':      QUOTE_CONDITIONS,
  'quote.expired':       QUOTE_CONDITIONS,
  'quote.revised':       QUOTE_CONDITIONS,

  // Quote lifecycle — cron
  'quote.expiring_soon': [
    ...QUOTE_CONDITIONS,
    { path: 'days_until_expire', label: 'Days until expiration' },
  ],

  // Opportunity lifecycle
  'opportunity.stage_changed': [
    { path: 'stage_to',                     label: 'New stage',               values: 'stages' },
    { path: 'stage_from',                   label: 'Previous stage',          values: 'stages' },
    { path: 'opportunity.transaction_type', label: 'Opportunity type',        values: 'transaction_types' },
    { path: 'opportunity.owner_user_id',    label: 'Opportunity owner (user id)' },
  ],
  'opportunity.stalled': [
    { path: 'opportunity.stage',            label: 'Opportunity stage',       values: 'stages' },
    { path: 'opportunity.transaction_type', label: 'Opportunity type',        values: 'transaction_types' },
    { path: 'opportunity.owner_user_id',    label: 'Opportunity owner (user id)' },
    { path: 'days_stalled',                 label: 'Days stalled' },
  ],

  // Job lifecycle
  'oc.issued':              JOB_CONDITIONS,
  'ntp.issued':             JOB_CONDITIONS,
  'authorization.received': JOB_CONDITIONS,
  'job.handed_off':         JOB_CONDITIONS,
  'job.completed':          JOB_CONDITIONS,

  // Price builds (cron)
  'price_build.stale': [
    { path: 'cost_build.status',            label: 'Price build status' },
    { path: 'quote.quote_type',             label: 'Quote type',              values: 'quote_types' },
    { path: 'opportunity.stage',            label: 'Opportunity stage',       values: 'stages' },
    { path: 'days_stale',                   label: 'Days since last update' },
  ],

  // Tasks
  'task.completed': [
    { path: 'task.type',                    label: 'Task type',               values: ['task', 'note', 'call', 'email', 'meeting'] },
    { path: 'task.subject',                 label: 'Task subject (contains)' },
    { path: 'task.assigned_user_id',        label: 'Assigned user id' },
    { path: 'opportunity.stage',            label: 'Opportunity stage',       values: 'stages' },
  ],
  'task.overdue': [
    { path: 'task.type',                    label: 'Task type',               values: ['task', 'note', 'call', 'email', 'meeting'] },
    { path: 'task.assigned_user_id',        label: 'Assigned user id' },
    { path: 'days_overdue',                 label: 'Days overdue' },
    { path: 'opportunity.stage',            label: 'Opportunity stage',       values: 'stages' },
  ],

  // System
  'system.error': [
    { path: 'error.code',                   label: 'Error code',              values: 'error_codes' },
  ],
};

// Re-used quote-scoped token set (quote.issued / accepted / rejected /
// expired / revised).
const QUOTE_TOKENS = [
  { path: 'quote.number',             label: 'Quote number' },
  { path: 'quote.revision',           label: 'Quote revision' },
  { path: 'quote.title',              label: 'Quote title' },
  { path: 'quote.quote_type',         label: 'Quote type' },
  { path: 'quote.status',             label: 'Quote status' },
  { path: 'opportunity.number',       label: 'Opportunity number' },
  { path: 'opportunity.title',        label: 'Opportunity title' },
  { path: 'account.name',             label: 'Account name' },
  { path: 'account.alias',            label: 'Account alias' },
  { path: 'trigger.user.display_name',label: 'Acting user name' },
];

// Re-used job-scoped token set (oc.issued / ntp.issued /
// authorization.received / job.handed_off / job.completed).
const JOB_TOKENS = [
  { path: 'job.oc_number',            label: 'OC number' },
  { path: 'job.status',               label: 'Job status' },
  { path: 'opportunity.number',       label: 'Opportunity number' },
  { path: 'opportunity.title',        label: 'Opportunity title' },
  { path: 'account.name',             label: 'Account name' },
  { path: 'account.alias',            label: 'Account alias' },
  { path: 'trigger.user.display_name',label: 'Acting user name' },
];

export const TOKEN_PATHS = {
  // Quote lifecycle
  'quote.issued':        QUOTE_TOKENS,
  'quote.accepted':      QUOTE_TOKENS,
  'quote.rejected':      QUOTE_TOKENS,
  'quote.expired':       QUOTE_TOKENS,
  'quote.revised':       QUOTE_TOKENS,
  'quote.expiring_soon': [
    ...QUOTE_TOKENS,
    { path: 'days_until_expire',    label: 'Days until expiration' },
    { path: 'quote.valid_until',    label: 'Quote valid-until date' },
  ],

  // Opportunity lifecycle
  'opportunity.stage_changed': [
    { path: 'opportunity.number',       label: 'Opportunity number' },
    { path: 'opportunity.title',        label: 'Opportunity title' },
    { path: 'stage_from',               label: 'Previous stage' },
    { path: 'stage_to',                 label: 'New stage' },
    { path: 'account.name',             label: 'Account name' },
    { path: 'trigger.user.display_name',label: 'Acting user name' },
  ],
  'opportunity.stalled': [
    { path: 'opportunity.number',       label: 'Opportunity number' },
    { path: 'opportunity.title',        label: 'Opportunity title' },
    { path: 'opportunity.stage',        label: 'Opportunity stage' },
    { path: 'days_stalled',             label: 'Days stalled' },
    { path: 'account.name',             label: 'Account name' },
  ],

  // Job lifecycle
  'oc.issued':              JOB_TOKENS,
  'ntp.issued':             JOB_TOKENS,
  'authorization.received': JOB_TOKENS,
  'job.handed_off':         JOB_TOKENS,
  'job.completed':          JOB_TOKENS,

  // Price builds
  'price_build.stale': [
    { path: 'cost_build.id',            label: 'Price build id' },
    { path: 'cost_build.status',        label: 'Price build status' },
    { path: 'quote.number',             label: 'Quote number' },
    { path: 'quote.title',              label: 'Quote title' },
    { path: 'opportunity.number',       label: 'Opportunity number' },
    { path: 'account.name',             label: 'Account name' },
    { path: 'days_stale',               label: 'Days since last update' },
  ],

  // Tasks
  'task.completed': [
    { path: 'task.subject',             label: 'Task subject' },
    { path: 'task.type',                label: 'Task type' },
    { path: 'opportunity.number',       label: 'Opportunity number' },
    { path: 'account.name',             label: 'Account name' },
  ],
  'task.overdue': [
    { path: 'task.subject',             label: 'Task subject' },
    { path: 'task.type',                label: 'Task type' },
    { path: 'task.due_at',              label: 'Task due date' },
    { path: 'days_overdue',             label: 'Days overdue' },
    { path: 'opportunity.number',       label: 'Opportunity number' },
    { path: 'account.name',             label: 'Account name' },
  ],

  // System
  'system.error': [
    { path: 'error.code',               label: 'Error code' },
    { path: 'error.summary',            label: 'Error summary' },
    { path: 'error.detail',             label: 'Error detail' },
    { path: 'error.context',            label: 'Error context' },
  ],
};

// Mirrors the production stage_definitions catalog. Stored per-key
// so UI shows friendly labels; engine conditions match against the
// raw key. The catalog has been carefully evolved from the seed —
// keep this list in sync with the live catalog when it changes.
export const STAGE_KEYS = [
  // Pre-quote
  { key: 'lead',                              label: 'Lead' },
  { key: 'rfq_received',                      label: 'RFQ received' },
  { key: 'awaiting_client_feedback',          label: 'Awaiting client feedback' },

  // Quote cycle
  { key: 'quote_drafted',                     label: 'Quote drafted' },
  { key: 'quote_submitted',                   label: 'Quote submitted' },
  { key: 'quote_under_revision',              label: 'Quote under revision' },
  { key: 'revised_quote_submitted',           label: 'Revised quote submitted' },

  // OC / win
  { key: 'oc_drafted',                        label: 'OC drafted' },
  { key: 'won',                               label: 'Won (OC issued)' },
  { key: 'oc_submitted',                      label: 'OC submitted' },

  // Post-win execution + change-order cycle
  { key: 'job_in_progress',                   label: 'Job in progress' },
  { key: 'change_order_drafted',              label: 'Change order drafted' },
  { key: 'change_order_submitted',            label: 'Change order submitted' },
  { key: 'change_order_under_revision',       label: 'Change order under revision' },
  { key: 'revised_change_order_submitted',    label: 'Revised change order submitted' },
  { key: 'change_order_won',                  label: 'Change order won' },
  { key: 'amended_oc_drafted',                label: 'Amended OC drafted' },
  { key: 'amended_oc_submitted',              label: 'Amended OC submitted' },
  { key: 'completed',                         label: 'Completed' },

  // Terminal — losses
  { key: 'lost',                              label: 'Lost' },
  { key: 'abandoned',                         label: 'Abandoned' },
];

export const TRANSACTION_TYPES = [
  { key: 'spares',  label: 'Spares' },
  { key: 'eps',     label: 'EPS' },
  { key: 'refurb',  label: 'Refurb' },
  { key: 'service', label: 'Service' },
];

export const QUOTE_TYPES = [
  { key: 'spares',              label: 'Spares' },
  { key: 'eps',                 label: 'EPS' },
  { key: 'refurb_baseline',     label: 'Refurb — baseline' },
  { key: 'refurb_modified',     label: 'Refurb — modified' },
  { key: 'refurb_supplemental', label: 'Refurb — supplemental' },
  { key: 'service',             label: 'Service' },
];

export const ERROR_CODES = [
  { key: 'pdf_generation_failed',  label: 'PDF generation failed' },
  { key: 'docx_generation_failed', label: 'DOCX generation failed' },
];

export const ASSIGNEE_OPTIONS = [
  { key: 'trigger.user',      label: 'User who triggered the event' },
  { key: 'opportunity.owner', label: 'Opportunity owner' },
  { key: 'quote.owner',       label: 'Quote submitter (falls back to opp owner)' },
  { key: 'account.owner',     label: 'Account owner' },
  { key: 'specific',          label: 'A specific user...' },
];

export const LINK_OPTIONS = [
  { key: '',            label: '(none)' },
  { key: 'opportunity', label: 'Opportunity' },
  { key: 'quote',       label: 'Quote' },
  { key: 'account',     label: 'Account' },
];

// Expand a shorthand values reference on a CONDITION_PATHS entry.
export function resolveValueHints(values) {
  if (!values) return null;
  if (Array.isArray(values)) return values.map((v) => ({ key: v, label: v }));
  if (values === 'stages') return STAGE_KEYS;
  if (values === 'transaction_types') return TRANSACTION_TYPES;
  if (values === 'quote_types') return QUOTE_TYPES;
  if (values === 'error_codes') return ERROR_CODES;
  return null;
}
