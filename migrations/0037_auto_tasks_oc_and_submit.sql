-- 0037_auto_tasks_oc_and_submit.sql
--
-- Phase 2 auto-tasks expansion. Three things happen here:
--
--   1. Add a cron_runs table so the sidecar cron Worker can dedupe
--      scheduled sweeps. Every sweep inserts a row keyed by (sweep_key,
--      window_start). If the insert conflicts, the sweep already ran
--      for that window and we exit early.
--
--   2. Seed two new auto-task rules that replace previously hard-coded
--      task generation:
--        - "Submit {quote.number} to {account.name}" on quote.issued
--          (replaces the createIssueTask helper in quote-transitions.js,
--          which gets removed in the same commit). Active.
--        - "Notify Finance to send initial invoice" on oc.issued.
--          Active. Fires when an Order Confirmation is issued on any
--          job.
--
--   3. The rules engine and wizard don't need any schema changes — the
--      new triggers (quote.accepted / quote.rejected / quote.expired /
--      quote.revised / oc.issued / ntp.issued / authorization.received /
--      job.handed_off / job.completed / quote.expiring_soon /
--      task.overdue / opportunity.stalled / price_build.stale) are
--      string keys in task_rules.trigger — the TRIGGERS list in
--      functions/settings/auto-tasks/index.js + CONDITION_PATHS /
--      TOKEN_PATHS in rule-schema.js handle the UI side.

CREATE TABLE IF NOT EXISTS cron_runs (
  sweep_key      TEXT NOT NULL,
  window_start   TEXT NOT NULL,  -- ISO 8601 bucket boundary (e.g. '2026-04-17T09:00:00Z')
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  fired_count    INTEGER DEFAULT 0,
  skipped_count  INTEGER DEFAULT 0,
  error          TEXT,
  PRIMARY KEY (sweep_key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_cron_runs_sweep_started
  ON cron_runs(sweep_key, started_at DESC);

INSERT INTO task_rules (id, name, description, trigger, conditions_json, task_json, tz, active, created_at, updated_at)
VALUES (
  'rule-seed-submit-quote-to-customer',
  'Submit quote to customer',
  'When a quote is issued, create a task for the opportunity owner to submit it to the customer the next business day. Replaces the hard-coded createIssueTask helper.',
  'quote.issued',
  NULL,
  '{"title":"Submit {quote.number} to {account.name}","body":"Send {quote.number} rev {quote.revision} to {account.name}.","assignee":"opportunity.owner","due_at":"+1d@cob","reminders":[],"link":"quote"}',
  'America/Chicago',
  1,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
);

INSERT INTO task_rules (id, name, description, trigger, conditions_json, task_json, tz, active, created_at, updated_at)
VALUES (
  'rule-seed-notify-finance-initial-invoice',
  'Notify Finance to send initial invoice',
  'When an Order Confirmation is issued, create a task reminding the opportunity owner to notify Finance to send the initial invoice.',
  'oc.issued',
  NULL,
  '{"title":"Notify Finance to send initial invoice for {opportunity.number} ({account.name})","body":"OC {job.oc_number} was issued for {opportunity.number} {opportunity.title}. Ping Finance so the initial invoice goes out.","assignee":"opportunity.owner","due_at":"+1d@cob","reminders":["-2h"],"link":"opportunity"}',
  'America/Chicago',
  1,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
);
