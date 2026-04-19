-- =====================================================================
-- Migration 0042: Seed auto-task rules for OC + NTP submit-to-customer.
--
-- Parallels the existing `rule-seed-submit-quote-to-customer` rule
-- (migration 0037). When an OC or NTP is issued, the rules engine
-- creates a task prompting the opportunity owner to send the document
-- to the customer. When the task is marked complete,
-- advanceStageOnTaskComplete() (functions/lib/stage-transitions.js)
-- advances the opportunity stage to the corresponding `*_submitted`
-- stage from migration 0041.
--
-- Stage advance mapping (handled in code, not data):
--   rule-seed-submit-oc-to-customer   → oc_submitted
--   rule-seed-submit-ntp-to-customer  → ntp_submitted
-- =====================================================================

INSERT INTO task_rules (
  id, name, description, trigger, conditions_json, task_json, tz, active, created_at, updated_at
) VALUES (
  'rule-seed-submit-oc-to-customer',
  'Submit OC to customer',
  'When an Order Confirmation is issued, create a task for the opportunity owner to submit it to the customer the next business day. Completing the task advances the opp to OC submitted.',
  'oc.issued',
  NULL,
  '{"title":"Submit OC {job.oc_number} to {account.name}","body":"Send OC {job.oc_number} for {opportunity.number} to {account.name}.","assignee":"opportunity.owner","due_at":"+1d@cob","reminders":[],"link":"opportunity"}',
  'America/Chicago',
  1,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
);

INSERT INTO task_rules (
  id, name, description, trigger, conditions_json, task_json, tz, active, created_at, updated_at
) VALUES (
  'rule-seed-submit-ntp-to-customer',
  'Submit NTP to customer',
  'When a Notice to Proceed is issued (EPS only), create a task for the opportunity owner to submit it to the customer the next business day. Completing the task advances the opp to NTP submitted.',
  'ntp.issued',
  NULL,
  '{"title":"Submit NTP {job.ntp_number} to {account.name}","body":"Send NTP {job.ntp_number} for {opportunity.number} to {account.name}.","assignee":"opportunity.owner","due_at":"+1d@cob","reminders":[],"link":"opportunity"}',
  'America/Chicago',
  1,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
);
