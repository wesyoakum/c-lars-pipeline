-- =====================================================================
-- Migration 0070 — Claudia background-tick observations + event queue.
--
-- Two tables, both isolated to the Sandbox-Assistant feature so the
-- experiment can be ripped out cleanly:
--
--   * claudia_events_pending — tiny queue. Pipeline handlers (stage
--     change, task complete, etc.) INSERT rows here so the hourly
--     cron tick has a list of "things that just happened" to consider.
--     Each row is marked processed_at when the tick consumes it.
--
--   * claudia_observations — what the hourly tick produces. Free-form
--     markdown body, surfaced as a panel at the top of /sandbox/assistant.
--     Wes can dismiss; observations auto-fade from the panel after 24h.
--
-- Reversible: dropping these two tables removes the whole background
-- polling feature with zero schema fallout elsewhere.
-- =====================================================================

CREATE TABLE IF NOT EXISTS claudia_events_pending (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  type          TEXT NOT NULL,           -- 'opp_stage_change' | 'task_completed' | future kinds
  ref_id        TEXT,                    -- the affected entity id (opp id, activity id, etc.)
  summary       TEXT,                    -- one-line human-readable
  created_at    TEXT NOT NULL,
  processed_at  TEXT                     -- nullable; set when the tick consumes
);

CREATE INDEX IF NOT EXISTS idx_claudia_events_pending_open
  ON claudia_events_pending(user_id, created_at)
  WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS claudia_observations (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  body          TEXT NOT NULL,           -- markdown
  source_kind   TEXT NOT NULL,           -- 'hourly_tick' for now; reserved for 'manual', 'event_burst', etc.
  created_at    TEXT NOT NULL,
  dismissed_at  TEXT                     -- nullable; user clicked dismiss
);

CREATE INDEX IF NOT EXISTS idx_claudia_obs_user
  ON claudia_observations(user_id, created_at DESC);
