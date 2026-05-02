-- =====================================================================
-- Migration 0076 — Claudia "catch me up" brief.
--
-- A single-row-per-user snapshot Claudia rewrites on the hourly cron
-- tick (and on demand via regenerateBrief). When Wes asks "catch me
-- up" she returns this row's body verbatim instead of recomputing
-- from scratch every time. Difference from claudia_observations:
-- observations are point-in-time notes that pile up; the brief is a
-- single ROLLING snapshot of "what matters right now."
--
-- Schema: PRIMARY KEY on user_id makes this an upsert — there's only
-- ever one brief per user. body is markdown; generated_at lets the
-- read_brief tool annotate "freshness" so Claudia can say "this is
-- 47 minutes old" if it's stale. state_hash is optional and lets the
-- generator skip the LLM call when the input state hasn't changed.
--
-- Reversible: dropping the table just means Wes loses the cached
-- brief and Claudia falls back to "I don't have a snapshot — let me
-- compose one fresh" on the next ask.
-- =====================================================================

CREATE TABLE IF NOT EXISTS claudia_brief (
  user_id        TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  body           TEXT NOT NULL,
  generated_at   TEXT NOT NULL,
  state_hash     TEXT,
  source_event   TEXT          -- e.g. 'cron_tick', 'manual_refresh', 'first_load'
);
