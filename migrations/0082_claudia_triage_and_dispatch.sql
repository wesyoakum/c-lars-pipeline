-- =====================================================================
-- Migration 0082 — Claudia triage layer + event dispatch metadata.
--
-- Two tables and three new columns on claudia_events_pending. Both
-- tables are scoped to the Sandbox-Assistant feature; dropping them
-- removes the triage/questions UI without affecting Pipeline data.
--
--   * claudia_triage_items — every meaningful "thing that landed"
--     (drop-zone doc, AI-Inbox upload, optionally a Pipeline event)
--     gets one row, classified into Hot / Plan / Quick / Skip on the
--     Eisenhower importance × urgency matrix. An item may carry a
--     proposed_action_json (when the model has an actionable
--     recommendation); approving it executes through claudia-writes.js
--     so the standard 72h undo applies.
--
--     Re-evaluation overwrites quadrant / importance / urgency /
--     summary / rationale / context_json on the same row, bumping
--     evaluation_count. Cross-row history of moves is captured in
--     audit_events (entity_type='claudia_triage_item').
--
--   * claudia_questions — anything Claudia is uncertain about. Wes
--     answers in chat or inline-edits the answer field. Answers feed
--     back into the next triage re-evaluation.
--
-- Dispatch columns on claudia_events_pending track which events have
-- been picked up by the new event-driven worker (vs. the legacy
-- hourly tick). The hourly tick sweeps `WHERE dispatched_at IS NULL`
-- as a fallback so events survive a consumer outage.
--
-- Reversible: dropping the two tables and the three ALTER columns
-- removes the entire triage/dispatch surface; existing observations
-- and pending-events behavior is unaffected.
-- =====================================================================

CREATE TABLE IF NOT EXISTS claudia_triage_items (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),

  -- What this triage item is about.
  source_table    TEXT NOT NULL,                -- 'claudia_documents' | 'ai_inbox_items' | 'event'
  source_id       TEXT NOT NULL,                -- id of the doc / inbox item / event row
  source_event_id TEXT,                         -- optional FK-ish to claudia_events_pending.id
  origin          TEXT NOT NULL,                -- 'drop_zone' | 'ai_inbox' | 'event' | 'chat'

  -- Claudia's take.
  title           TEXT NOT NULL,                -- short scannable summary (under 80 chars)
  summary         TEXT,                         -- 1–3 sentence Claudia take
  rationale       TEXT,                         -- why she put it in this quadrant; expand-on-hover

  -- The four-quadrant matrix.
  quadrant        TEXT NOT NULL
                    CHECK (quadrant IN ('hot','plan','quick','skip')),
  importance      REAL,                         -- 0..1
  urgency         REAL,                         -- 0..1

  -- Optional proposed action (one of the catalog tools). Approve
  -- executes edited_action_json ?? proposed_action_json via
  -- claudia-writes.js so standard 72h undo applies.
  proposed_action_json  TEXT,                   -- { tool, payload, confidence }
  edited_action_json    TEXT,                   -- non-null if Wes edited before approve

  -- Enrichment snapshot at the latest evaluation. Updated when
  -- re-evaluated; previous snapshots are not retained (audit_events
  -- carries the move history).
  context_json    TEXT,

  -- Lifecycle.
  status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','resolved','ignored','merged','expired')),
  resolved_at     TEXT,
  resolved_reason TEXT,                         -- 'action_executed' | 'manual_resolve' | 'related_entity_closed' | 'merged_into:<id>' | 'auto_skip'
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

-- The active-tray query: open items per quadrant, newest first.
CREATE INDEX IF NOT EXISTS idx_claudia_triage_open
  ON claudia_triage_items(user_id, quadrant, created_at DESC)
  WHERE status = 'open';

-- Lookup by source row — used to find an existing row for the same
-- doc/inbox item before creating a duplicate during re-evaluation.
CREATE INDEX IF NOT EXISTS idx_claudia_triage_source
  ON claudia_triage_items(source_table, source_id);

-- Lookup by triggering event — used by the consumer worker to find
-- prior triage rows produced by the same event id (idempotency).
CREATE INDEX IF NOT EXISTS idx_claudia_triage_event
  ON claudia_triage_items(source_event_id)
  WHERE source_event_id IS NOT NULL;


CREATE TABLE IF NOT EXISTS claudia_questions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),

  -- Optional link back to the triage item that raised the question.
  -- Chat-raised questions leave this NULL.
  source_triage_id TEXT REFERENCES claudia_triage_items(id),

  question        TEXT NOT NULL,
  context         TEXT,                         -- shown inline beneath the question

  answer          TEXT,
  status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','answered','dropped')),
  answered_at     TEXT,
  answered_by_user_id TEXT REFERENCES users(id),

  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- The active-questions panel query.
CREATE INDEX IF NOT EXISTS idx_claudia_questions_open
  ON claudia_questions(user_id, created_at DESC)
  WHERE status = 'open';


-- Dispatch metadata on the events queue. The new event-driven worker
-- sets dispatched_at when it finishes processing; the hourly cron
-- sweeps `WHERE dispatched_at IS NULL` as a fallback for events the
-- queue consumer never delivered.
ALTER TABLE claudia_events_pending ADD COLUMN dispatched_at TEXT;
ALTER TABLE claudia_events_pending ADD COLUMN dispatch_error TEXT;

-- One-line outcome string for observability:
--   'auto:refresh_brief' | 'triage:hot:create_activity' | 'observe' | 'noop'
ALTER TABLE claudia_events_pending ADD COLUMN action_summary TEXT;
