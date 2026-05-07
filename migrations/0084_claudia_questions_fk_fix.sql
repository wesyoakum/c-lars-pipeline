-- =====================================================================
-- Migration 0084 — Fix claudia_questions.source_action_id FK target.
--
-- Migration 0083 used `ALTER TABLE … RENAME COLUMN source_triage_id
-- TO source_action_id`. SQLite's RENAME COLUMN updates the column NAME
-- but does NOT rewrite the column's FK target — so the column is still
-- declared as `REFERENCES claudia_triage_items(id)`, even though that
-- table was dropped in the same migration.
--
-- With foreign_keys=ON (D1 local default; D1 remote enforces too) any
-- INSERT into claudia_questions raises "no such table:
-- claudia_triage_items".
--
-- Fix: recreate the table with the correct FK target via the SQLite
-- "12-step ALTER TABLE" recipe. The table is empty in production
-- (no events have populated it yet), so the data copy is a no-op.
--
-- Reversible: revert by recreating claudia_questions with the old FK
-- target. (No data loss since the table is empty.)
-- =====================================================================

CREATE TABLE claudia_questions_new (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  source_action_id TEXT REFERENCES claudia_actions(id),
  question        TEXT NOT NULL,
  context         TEXT,
  answer          TEXT,
  status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','answered','dropped')),
  answered_at     TEXT,
  answered_by_user_id TEXT REFERENCES users(id),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

INSERT INTO claudia_questions_new
  (id, user_id, source_action_id, question, context, answer, status,
   answered_at, answered_by_user_id, created_at, updated_at)
SELECT
  id, user_id, source_action_id, question, context, answer, status,
  answered_at, answered_by_user_id, created_at, updated_at
FROM claudia_questions;

DROP TABLE claudia_questions;
ALTER TABLE claudia_questions_new RENAME TO claudia_questions;

CREATE INDEX IF NOT EXISTS idx_claudia_questions_open
  ON claudia_questions(user_id, created_at DESC) WHERE status = 'open';
