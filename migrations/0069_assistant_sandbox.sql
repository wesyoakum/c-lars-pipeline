-- =====================================================================
-- Migration 0069 — Sandbox Assistant (Phase 1 shell).
--
-- Personal AI chat assistant for the Sandbox tab. Single-user (Wes-only),
-- isolated from the rest of the schema — no FK fan-out into accounts /
-- opportunities / tasks. The assistant READS those tables via tool-use
-- but does not write to them yet.
--
-- Three tables:
--   * assistant_threads  — one chat thread per row (we'll only use one
--     "main" thread for now, but keep the table so we can add more later).
--   * assistant_messages — turn-by-turn record; role is 'user' | 'assistant'.
--     Stores the final user-visible text per turn. The tool-use loop
--     happens within a single assistant turn and is not persisted here
--     (yet — Phase 2 may add tool_call_log if useful for debugging).
--   * assistant_memory   — key/value the model can read & append-to via
--     tools. Used for travel prefs, ongoing context, "remind me about X"
--     jots, etc. Per-user so future multi-user is a no-op.
--
-- Reversible: dropping these three tables removes the feature with zero
-- schema impact elsewhere.
-- =====================================================================

CREATE TABLE IF NOT EXISTS assistant_threads (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  title       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assistant_threads_user
  ON assistant_threads(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS assistant_messages (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assistant_messages_thread
  ON assistant_messages(thread_id, created_at);

CREATE TABLE IF NOT EXISTS assistant_memory (
  user_id     TEXT NOT NULL REFERENCES users(id),
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
