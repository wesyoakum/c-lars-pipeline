-- 0036_auto_tasks.sql
--
-- Auto-tasks Phase 1 — rules engine that creates tasks in response to
-- events fired elsewhere in the app.
--
-- Three tables:
--
--   task_rules        — the rule definitions (one row per rule). Each rule
--                       binds a trigger event to a task template plus
--                       optional conditions + reminders.
--   task_rule_fires   — dedupe + audit log. Every time a rule fires, we
--                       write a row here keyed by (rule_id, event_key).
--                       event_key is computed by the engine from the
--                       payload and is meant to be stable for a logical
--                       event (e.g. `quote.issued:<quote_id>`). A UNIQUE
--                       index on (rule_id, event_key) means the same
--                       event cannot fire the same rule twice — important
--                       for idempotency if a route handler retries.
--   task_reminders    — scheduled reminder notifications. When a rule's
--                       template includes `"reminders": ["-1d@09:00"]`
--                       the engine inserts one row per reminder offset
--                       with `fires_at` precomputed. The /notifications/
--                       unread polling endpoint sweeps this table every
--                       30s, fires any due reminders as notifications,
--                       and stamps `fired_at` so they don't double-fire.
--
-- The rule definition and the task template are both stored as JSON
-- blobs (conditions_json, task_json) so we can evolve the schema
-- without per-field migrations. See functions/lib/auto-tasks.js for
-- the reader/validator.
--
-- Why not store conditions as separate columns? Each rule can have
-- zero-to-many conditions on arbitrary payload paths (quote.status,
-- quote.is_hybrid, opportunity.owner, error.code, etc.). A flat table
-- would either require a side table (N rows per rule) or a wide sparse
-- schema that gets stale as new payload fields emerge. JSON blob is
-- the same pattern used by audit_events.changes_json.

CREATE TABLE IF NOT EXISTS task_rules (
  id                  TEXT PRIMARY KEY,

  -- Human-readable name shown in the management UI (Phase 2).
  name                TEXT NOT NULL,
  description         TEXT,

  -- Trigger event key, e.g. 'quote.issued', 'opportunity.stage_changed',
  -- 'task.completed', 'system.error'. The engine dispatches based on
  -- this string. See functions/lib/auto-tasks.js for the enum.
  trigger             TEXT NOT NULL,

  -- JSON object keyed by payload path → expected value or {in:[…]}.
  -- Empty/null means "no conditions, fire for every event of this
  -- trigger type".
  --
  -- Example:
  --   { "quote.quote_type": "spares",
  --     "opportunity.stage": { "in": ["qualified","proposal_sent"] } }
  conditions_json     TEXT,

  -- JSON object describing the task to create. Required keys:
  --   title     — string, supports {payload.path} substitution
  --   body      — optional string, same substitution rules
  --   assignee  — string selector: 'trigger.user', 'opportunity.owner',
  --                'quote.owner', 'user:<uuid>', or a payload path
  --   due_at    — DSL string: '+Nd', '+Nh', '+Nd@cob', '+Nd@09:00',
  --                'next_friday@cob', 'tomorrow@09:00', or null for
  --                "no due date"
  --   reminders — optional array of negative offsets: ['-1d@09:00',
  --                '-2h'] — parsed relative to due_at
  --   link      — optional 'opportunity' | 'quote' | 'account'; the
  --                engine uses the payload's matching entity_id to
  --                populate activities.opportunity_id / quote_id /
  --                account_id
  task_json           TEXT NOT NULL,

  -- Timezone for due-at / reminder computations. Phase 1 always stores
  -- 'America/Chicago' (the home tz). Stored per-rule so Phase-2
  -- timezone-aware scheduling per user doesn't need another migration.
  tz                  TEXT NOT NULL DEFAULT 'America/Chicago',

  -- Paused rules are loaded but skipped. 1 = active, 0 = paused.
  active              INTEGER NOT NULL DEFAULT 1,

  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by_user_id  TEXT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_task_rules_trigger_active
  ON task_rules(trigger, active);


-- Idempotency + audit for rule firings. The engine computes an
-- event_key per event (e.g. 'quote.issued:<quote_id>' for quote events,
-- 'stage_changed:<opp_id>:<from_stage>:<to_stage>' for stage changes).
-- We insert with INSERT OR IGNORE on (rule_id, event_key) so duplicate
-- events from route-handler retries don't double-create tasks.
CREATE TABLE IF NOT EXISTS task_rule_fires (
  id         TEXT PRIMARY KEY,
  rule_id    TEXT NOT NULL REFERENCES task_rules(id) ON DELETE CASCADE,
  event_key  TEXT NOT NULL,
  fired_at   TEXT NOT NULL,
  task_id    TEXT REFERENCES activities(id) ON DELETE SET NULL,
  UNIQUE (rule_id, event_key)
);

CREATE INDEX IF NOT EXISTS idx_task_rule_fires_rule
  ON task_rule_fires(rule_id, fired_at DESC);


-- Scheduled reminders. When a rule's task_json includes a reminders[]
-- array, the engine computes fires_at = (due_at + offset) and inserts
-- one row per reminder. A polling sweep (inside /notifications/unread)
-- fires any rows where fires_at <= now() AND fired_at IS NULL, then
-- stamps fired_at + notification_id so the reminder doesn't fire twice.
CREATE TABLE IF NOT EXISTS task_reminders (
  id              TEXT PRIMARY KEY,
  activity_id     TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id),

  -- UTC ISO string. Stored in UTC so the poll can do a simple string
  -- comparison against now().
  fires_at        TEXT NOT NULL,

  -- Stamped when the reminder has been turned into a notification.
  -- NULL = pending.
  fired_at        TEXT,
  notification_id TEXT REFERENCES notifications(id) ON DELETE SET NULL,

  -- For debugging / "why did this reminder fire" traceback.
  source_rule_id  TEXT REFERENCES task_rules(id)   ON DELETE SET NULL,
  source_fire_id  TEXT REFERENCES task_rule_fires(id) ON DELETE SET NULL
);

-- Sweep query: "all pending reminders due by now". Ordered so small
-- batches fire in chronological order.
CREATE INDEX IF NOT EXISTS idx_task_reminders_pending
  ON task_reminders(fires_at)
  WHERE fired_at IS NULL;


-- Link a generated task back to the rule that created it. Used by the
-- audit trail + the "see what created this task" tooltip in Phase 2.
ALTER TABLE activities ADD COLUMN source_rule_id TEXT REFERENCES task_rules(id) ON DELETE SET NULL;
ALTER TABLE activities ADD COLUMN source_fire_id TEXT REFERENCES task_rule_fires(id) ON DELETE SET NULL;


-- -------------------------------------------------------------------
-- Starter rules — three examples to prove the engine works end-to-end.
-- Disable / edit via SQL in Phase 1; Phase 2 adds the admin UI.
-- -------------------------------------------------------------------

-- Rule A: Quote issued → follow-up task in 7 days
--   Trigger: quote.issued
--   No conditions (fires for every issued quote).
--   Task:
--     title: "Follow up on {quote.number} with {account.name}"
--     assignee: opportunity.owner
--     due: +7 days at close-of-business Central
--     reminder: -1 day at 09:00 Central
INSERT INTO task_rules (id, name, description, trigger, conditions_json, task_json, tz, active, created_at, updated_at)
VALUES (
  'rule-seed-quote-issued-followup',
  'Follow up 7 days after a quote is issued',
  'When any quote is issued, create a task for the opportunity owner to follow up with the customer one week later.',
  'quote.issued',
  NULL,
  '{"title":"Follow up on {quote.number} with {account.name}","body":"Check whether {account.name} has questions about {quote.number} rev {quote.revision}.","assignee":"opportunity.owner","due_at":"+7d@cob","reminders":["-1d@09:00"],"link":"opportunity"}',
  'America/Chicago',
  1,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
);

-- Rule B: Opportunity closed as won → kickoff checklist
--   Trigger: opportunity.stage_changed
--   Condition: new stage IS closed_won (stage_key shared across all
--   transaction types per migration 0002/0003 seed rows).
INSERT INTO task_rules (id, name, description, trigger, conditions_json, task_json, tz, active, created_at, updated_at)
VALUES (
  'rule-seed-customer-awarded-kickoff',
  'Create kickoff task when opportunity closes as won',
  'When an opportunity closes as won, create a kickoff-checklist task for the owner due the next business day.',
  'opportunity.stage_changed',
  '{"opportunity.stage":"closed_won"}',
  '{"title":"Kickoff checklist for {opportunity.number} {opportunity.title}","body":"Opportunity {opportunity.number} was won. Confirm PO received, kick off job tracking, and notify shop.","assignee":"opportunity.owner","due_at":"+1d@09:00","reminders":["-2h"],"link":"opportunity"}',
  'America/Chicago',
  1,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
);

-- Rule C: System error on PDF generation → investigation task for Wes
--   Trigger: system.error
--   Condition: error.code = 'pdf_generation_failed'
--   Assignee: fixed user (Wes) — the on-call for system errors.
INSERT INTO task_rules (id, name, description, trigger, conditions_json, task_json, tz, active, created_at, updated_at)
VALUES (
  'rule-seed-pdf-error-investigate',
  'Investigate PDF generation failures',
  'When a PDF fails to generate, create a task so Wes can look at it.',
  'system.error',
  '{"error.code":"pdf_generation_failed"}',
  '{"title":"PDF generation failed: {error.summary}","body":"{error.detail}\n\nContext: {error.context}","assignee":"trigger.user","due_at":"+1d@cob","reminders":["-2h"],"link":"quote"}',
  'America/Chicago',
  1,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
);
