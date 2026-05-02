-- =====================================================================
-- Migration 0072 — Claudia write-audit log.
--
-- Claudia gains a tightly-scoped write surface (create_contact,
-- update_contact, create_account, etc.). Every write she makes is
-- logged to this table with the before-and-after JSON of the affected
-- row so the user can verify what she did and undo within the 24-hour
-- window enforced by the undo_claudia_write tool.
--
-- Allowlist of writable refs lives in code (functions/lib/claudia-writes.js)
-- — this table records anything in that allowlist.
--
-- Reversible: dropping the table removes the audit history but does not
-- affect the data Claudia has written. Existing rows in contacts /
-- accounts stay; only the audit trail is lost.
-- =====================================================================

CREATE TABLE IF NOT EXISTS claudia_writes (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),

  -- 'create_contact' | 'update_contact' | 'create_account' | 'update_account' | ...
  action        TEXT NOT NULL,
  ref_table     TEXT NOT NULL,    -- 'contacts' | 'accounts'
  ref_id        TEXT NOT NULL,    -- id of the affected row

  before_json   TEXT,             -- NULL for creates; full row snapshot for updates
  after_json    TEXT NOT NULL,    -- full row snapshot after the write

  -- For batch operations Claudia kicks off (e.g. "create these 12
  -- contacts"), every row gets the same batch_id so undo can roll back
  -- the whole batch at once.
  batch_id      TEXT,

  -- Free-form one-line description Claudia (or the helper) writes
  -- when logging — surfaces nicely in any UI listing past writes.
  summary       TEXT,

  created_at    TEXT NOT NULL,
  undone_at     TEXT,             -- set when undo_claudia_write reverses
  undo_reason   TEXT              -- optional explanation
);

CREATE INDEX IF NOT EXISTS idx_claudia_writes_user_recent
  ON claudia_writes(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_claudia_writes_batch
  ON claudia_writes(batch_id)
  WHERE batch_id IS NOT NULL;
