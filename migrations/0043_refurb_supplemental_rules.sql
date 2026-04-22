-- =====================================================================
-- Migration 0043: Refurb supplemental loop — schema + auto-task rules.
--
-- Schema (new columns):
--
--   quotes.quote_kind TEXT DEFAULT 'baseline'
--     'baseline'     — the initial quote on an opportunity (default)
--     'supplemental' — a supplemental quote issued during the refurb
--                      teardown phase (stages 12–15 in the v2 catalog)
--     Supplementals reuse the whole quote pipeline (drafts, revisions,
--     accept/reject, PDF generation) — quote_kind is just a marker for
--     UI filtering and for the task rule that fires the correct event.
--
--   jobs.amended_oc_number        TEXT
--   jobs.amended_oc_issued_at     TEXT
--   jobs.amended_oc_issued_by_user_id TEXT
--   jobs.amended_oc_revision      INTEGER NOT NULL DEFAULT 1
--     Mirrors the existing oc_* fields but tracks the amended OC
--     issued after a supplemental scope is accepted (stages 17–18).
--
--   jobs.inspection_report_issued_at        TEXT
--   jobs.inspection_report_issued_by_user_id TEXT
--     Records the moment the inspection report was issued to the
--     customer, used to drive the inspection_report.issued event
--     and advance the opp to stage 11 (inspection_report_submitted)
--     when the auto-created task is completed.
--
-- Auto-task rules:
--
--   rule-seed-submit-inspection-report-to-customer   → stage 11
--   rule-seed-submit-supplemental-quote-to-customer  → stage 13 / 15
--   rule-seed-submit-amended-oc-to-customer          → stage 18
--
-- Stage-advance mapping for these rules lives in stage-transitions.js
-- (TASK_RULE_STAGE_MAP) — the rules engine only creates tasks; stage
-- advance happens via advanceStageOnTaskComplete() when the task's
-- status flips to 'completed'.
-- =====================================================================


-- ---------------------------------------------------------------------
-- (a) quotes.quote_kind
-- ---------------------------------------------------------------------

ALTER TABLE quotes
  ADD COLUMN quote_kind TEXT NOT NULL DEFAULT 'baseline';

CREATE INDEX IF NOT EXISTS idx_quotes_opp_kind
  ON quotes(opportunity_id, quote_kind);


-- ---------------------------------------------------------------------
-- (b) jobs.amended_oc_*, jobs.inspection_report_*
-- ---------------------------------------------------------------------

ALTER TABLE jobs ADD COLUMN amended_oc_number          TEXT;
ALTER TABLE jobs ADD COLUMN amended_oc_issued_at       TEXT;
ALTER TABLE jobs ADD COLUMN amended_oc_issued_by_user_id TEXT REFERENCES users(id);
ALTER TABLE jobs ADD COLUMN amended_oc_revision        INTEGER NOT NULL DEFAULT 1;

ALTER TABLE jobs ADD COLUMN inspection_report_issued_at         TEXT;
ALTER TABLE jobs ADD COLUMN inspection_report_issued_by_user_id TEXT REFERENCES users(id);


-- ---------------------------------------------------------------------
-- (c) Seeded auto-task rules.
-- ---------------------------------------------------------------------

INSERT INTO task_rules (
  id, name, description, trigger, conditions_json, task_json, tz, active, created_at, updated_at
) VALUES (
  'rule-seed-submit-inspection-report-to-customer',
  'Submit inspection report to customer',
  'When an inspection report is issued on a refurb job, create a task for the opportunity owner to submit it to the customer. Completing the task advances the opp to Inspection Report submitted.',
  'inspection_report.issued',
  NULL,
  '{"title":"Submit inspection report for {opportunity.number} to {account.name}","body":"Send the inspection report for {opportunity.number} to {account.name}.","assignee":"opportunity.owner","due_at":"+1d@cob","reminders":[],"link":"opportunity"}',
  'America/Chicago',
  1,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
);

INSERT INTO task_rules (
  id, name, description, trigger, conditions_json, task_json, tz, active, created_at, updated_at
) VALUES (
  'rule-seed-submit-supplemental-quote-to-customer',
  'Submit supplemental quote to customer',
  'When a supplemental quote is issued on a refurb opp, create a task for the opportunity owner to submit it to the customer. Completing the task advances the opp to Supplemental quote submitted (or Revised supplemental quote submitted for revisions).',
  'supplemental_quote.issued',
  NULL,
  '{"title":"Submit supplemental {quote.number} to {account.name}","body":"Send supplemental quote {quote.number} rev {quote.revision} to {account.name}.","assignee":"opportunity.owner","due_at":"+1d@cob","reminders":[],"link":"quote"}',
  'America/Chicago',
  1,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
);

INSERT INTO task_rules (
  id, name, description, trigger, conditions_json, task_json, tz, active, created_at, updated_at
) VALUES (
  'rule-seed-submit-amended-oc-to-customer',
  'Submit amended OC to customer',
  'When an amended Order Confirmation is issued on a refurb job, create a task for the opportunity owner to submit it to the customer. Completing the task advances the opp to Amended OC submitted.',
  'amended_oc.issued',
  NULL,
  '{"title":"Submit amended OC {job.amended_oc_number} to {account.name}","body":"Send amended OC {job.amended_oc_number} for {opportunity.number} to {account.name}.","assignee":"opportunity.owner","due_at":"+1d@cob","reminders":[],"link":"opportunity"}',
  'America/Chicago',
  1,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
);
