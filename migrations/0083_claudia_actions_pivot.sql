-- =====================================================================
-- Migration 0083 — Pivot from claudia_triage_items → claudia_actions.
--
-- Migration 0082 created `claudia_triage_items` as per-source
-- classification rows. Pivoting before that table sees any data:
-- the triage outputs are first-class actions/tasks/todos. Sources
-- (file, event, chat, future calendar/gmail, or self-raised "Stacy's
-- birthday is tomorrow") attach as metadata. One source can produce
-- 0..N action rows.
--
-- Concrete differences from claudia_triage_items:
--   * Renamed: source_table → source_ref_table; source_id → source_ref_id;
--     summary → detail; resolved_* → completed_*. Status enum loses
--     'resolved' / 'ignored' (now 'completed' / 'dismissed').
--   * Generalized: source_kind enum supersedes the implicit (table+id)
--     pair so chat- and self-raised actions (which have no source row)
--     can be first-class.
--   * New: raised_by ('claudia' | 'wes' | 'system'), due_at, plus
--     idx_claudia_actions_due for the "due-today" query.
--
-- claudia_triage_items is dropped (it's empty — table existed for
-- minutes between 0082 and this migration). Schema evolves; data does
-- not migrate.
--
-- claudia_questions.source_triage_id is renamed to source_action_id
-- since it now FKs into claudia_actions. The questions table is also
-- empty at the point of this migration.
--
-- Reversible: drop claudia_actions; recreate claudia_triage_items
-- from migration 0082; rename the questions FK back. (The pivot also
-- has no production data to preserve, so reversal is mechanical.)
-- =====================================================================

DROP TABLE IF EXISTS claudia_triage_items;

CREATE TABLE claudia_actions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),

  -- Source attaches as metadata. file/event have a source_ref_*; chat
  -- and self can leave them null. future: calendar / gmail.
  source_kind     TEXT NOT NULL
                    CHECK (source_kind IN ('file','event','chat','self','calendar','gmail')),
  source_ref_table TEXT,                        -- 'claudia_documents' | 'ai_inbox_items' | 'opportunities' | …
  source_ref_id   TEXT,
  source_event_id TEXT,                         -- claudia_events_pending.id when kind='event'
  raised_by       TEXT NOT NULL
                    CHECK (raised_by IN ('claudia','wes','system')),

  -- The action itself.
  title           TEXT NOT NULL,                -- short scannable, e.g. "Call Bob at Acme re: Q3 quote"
  detail          TEXT,                         -- multi-paragraph context, the why
  rationale       TEXT,                         -- why Claudia put it in this quadrant; expand-on-hover

  -- Eisenhower triage classification.
  quadrant        TEXT NOT NULL
                    CHECK (quadrant IN ('hot','plan','quick','skip')),
  importance      REAL,                         -- 0..1
  urgency         REAL,                         -- 0..1
  due_at          TEXT,                         -- nullable; informs urgency, rendered in row

  -- Optional concrete tool-call to execute when approved (e.g.
  -- create_activity). For Wes-life things ("Stacy's birthday") this
  -- stays null and the action is completed manually via the Done
  -- button.
  proposed_action_json TEXT,                    -- { tool, payload, confidence }
  edited_action_json   TEXT,                    -- non-null if Wes edited before approve

  -- Enrichment snapshot at the latest evaluation. Updated when
  -- re-evaluated; previous snapshots not retained (audit_events
  -- carries the move history).
  context_json    TEXT,

  -- Lifecycle.
  status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','completed','dismissed','merged','expired')),
  completed_at    TEXT,
  completed_reason TEXT,                        -- 'action_executed' | 'manual_complete' | 'dismissed_by_user' | 'related_entity_closed' | 'merged_into:<id>' | 'auto_skip'
  decided_at      TEXT,
  decided_by_user_id TEXT REFERENCES users(id),

  -- Linkage back to the executed write (for undo + history view).
  execution_audit_id TEXT,                      -- claudia_writes.id once executed
  execution_error TEXT,

  -- Re-evaluation tracking.
  last_evaluated_at TEXT,
  evaluation_count  INTEGER NOT NULL DEFAULT 1,

  -- Self-FK for "this duplicate item was merged into the canonical row".
  merged_into_id  TEXT,

  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- The active-tray query: open actions per quadrant, newest first.
CREATE INDEX idx_claudia_actions_open
  ON claudia_actions(user_id, quadrant, created_at DESC)
  WHERE status = 'open';

-- Lookup by source row — used to find existing actions for the same
-- source during re-evaluation, and to power the per-file drill-down
-- page.
CREATE INDEX idx_claudia_actions_source
  ON claudia_actions(source_ref_table, source_ref_id)
  WHERE source_ref_table IS NOT NULL;

-- Lookup by triggering event — idempotency when the queue redrives.
CREATE INDEX idx_claudia_actions_event
  ON claudia_actions(source_event_id)
  WHERE source_event_id IS NOT NULL;

-- Drives a "due today / due this week" view across quadrants.
CREATE INDEX idx_claudia_actions_due
  ON claudia_actions(user_id, due_at)
  WHERE status = 'open' AND due_at IS NOT NULL;

-- Rename the FK column on claudia_questions to match the new table
-- name. SQLite ≥ 3.25 (D1 is on a much newer build) supports
-- RENAME COLUMN natively; no data copy needed since the table is
-- empty at this point.
ALTER TABLE claudia_questions RENAME COLUMN source_triage_id TO source_action_id;
