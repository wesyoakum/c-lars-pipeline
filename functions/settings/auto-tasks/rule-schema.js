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

export const CONDITION_PATHS = {
  'quote.issued': [
    { path: 'quote.quote_type',             label: 'Quote type',              values: 'quote_types' },
    { path: 'quote.status',                 label: 'Quote status',            values: ['issued', 'revision_issued'] },
    { path: 'quote.is_hybrid',              label: 'Is hybrid quote?',        values: ['1', '0'] },
    { path: 'opportunity.stage',            label: 'Opportunity stage',       values: 'stages' },
    { path: 'opportunity.transaction_type', label: 'Opportunity type',        values: 'transaction_types' },
    { path: 'opportunity.owner_user_id',    label: 'Opportunity owner (user id)' },
    { path: 'account.name',                 label: 'Account name' },
  ],
  'opportunity.stage_changed': [
    { path: 'stage_to',                     label: 'New stage',               values: 'stages' },
    { path: 'stage_from',                   label: 'Previous stage',          values: 'stages' },
    { path: 'opportunity.transaction_type', label: 'Opportunity type',        values: 'transaction_types' },
    { path: 'opportunity.owner_user_id',    label: 'Opportunity owner (user id)' },
  ],
  'task.completed': [
    { path: 'task.type',                    label: 'Task type',               values: ['task', 'note', 'call', 'email', 'meeting'] },
    { path: 'task.subject',                 label: 'Task subject (contains)' },
    { path: 'task.assigned_user_id',        label: 'Assigned user id' },
    { path: 'opportunity.stage',            label: 'Opportunity stage',       values: 'stages' },
  ],
  'system.error': [
    { path: 'error.code',                   label: 'Error code',              values: 'error_codes' },
  ],
};

export const TOKEN_PATHS = {
  'quote.issued': [
    { path: 'quote.number',             label: 'Quote number' },
    { path: 'quote.revision',           label: 'Quote revision' },
    { path: 'quote.title',              label: 'Quote title' },
    { path: 'quote.quote_type',         label: 'Quote type' },
    { path: 'opportunity.number',       label: 'Opportunity number' },
    { path: 'opportunity.title',        label: 'Opportunity title' },
    { path: 'account.name',             label: 'Account name' },
    { path: 'account.alias',            label: 'Account alias' },
    { path: 'trigger.user.display_name',label: 'Acting user name' },
  ],
  'opportunity.stage_changed': [
    { path: 'opportunity.number',       label: 'Opportunity number' },
    { path: 'opportunity.title',        label: 'Opportunity title' },
    { path: 'stage_from',               label: 'Previous stage' },
    { path: 'stage_to',                 label: 'New stage' },
    { path: 'account.name',             label: 'Account name' },
    { path: 'trigger.user.display_name',label: 'Acting user name' },
  ],
  'task.completed': [
    { path: 'task.subject',             label: 'Task subject' },
    { path: 'task.type',                label: 'Task type' },
    { path: 'opportunity.number',       label: 'Opportunity number' },
    { path: 'account.name',             label: 'Account name' },
  ],
  'system.error': [
    { path: 'error.code',               label: 'Error code' },
    { path: 'error.summary',            label: 'Error summary' },
    { path: 'error.detail',             label: 'Error detail' },
    { path: 'error.context',            label: 'Error context' },
  ],
};

// Mirrors migration 0002/0003 stage seeds. Stored per-key so UI shows
// friendly labels; engine conditions match against the raw key.
export const STAGE_KEYS = [
  { key: 'prospect',        label: 'Prospect' },
  { key: 'qualified',       label: 'Qualified' },
  { key: 'proposal_sent',   label: 'Proposal sent' },
  { key: 'negotiation',     label: 'Negotiation' },
  { key: 'ntp_draft',       label: 'NTP draft (EPS)' },
  { key: 'ntp_issued',      label: 'NTP issued (EPS)' },
  { key: 'oc_drafted',      label: 'OC drafted' },
  { key: 'oc_issued',       label: 'OC issued' },
  { key: 'closed_won',      label: 'Closed — won' },
  { key: 'closed_lost',     label: 'Closed — lost' },
  { key: 'closed_died',     label: 'Closed — died' },
  { key: 'closed_abandoned',label: 'Closed — abandoned' },
];

export const TRANSACTION_TYPES = [
  { key: 'spares',        label: 'Spares' },
  { key: 'eps',           label: 'EPS' },
  { key: 'service',       label: 'Service' },
  { key: 'refurb_baseline', label: 'Refurb — baseline' },
  { key: 'refurb_major',  label: 'Refurb — major' },
];

export const QUOTE_TYPES = [
  { key: 'spares',        label: 'Spares' },
  { key: 'eps',           label: 'EPS' },
  { key: 'service',       label: 'Service' },
  { key: 'refurb_baseline', label: 'Refurb — baseline' },
  { key: 'refurb_major',  label: 'Refurb — major' },
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
