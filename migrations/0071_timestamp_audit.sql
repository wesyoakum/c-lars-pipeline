-- =====================================================================
-- Migration 0071 — created_at / updated_at coverage audit.
--
-- Per user request: "anything created should have a created date and
-- an updated date". This adds the missing timestamps to the entity-
-- creating tables that don't already have them, and backfills from
-- the closest existing equivalent (uploaded_at, effective_date, etc.).
--
-- Append-only event/log tables (audit_events, ai_inbox_links,
-- assistant_messages, notification_log, notifications,
-- task_reminders, task_rule_fires, claudia_observations,
-- claudia_writes, claudia_events_pending) are intentionally NOT
-- given an updated_at — those rows are immutable post-create.
--
-- SQLite quirk: ALTER TABLE ADD COLUMN cannot use a non-constant
-- DEFAULT (no strftime()). So columns are added nullable; backfill
-- runs in this migration; INSERT code paths must populate them
-- going forward.
-- =====================================================================

-- ---------- Document-shaped tables ----------

-- documents — `uploaded_at` is the existing semantic create stamp.
ALTER TABLE documents ADD COLUMN created_at TEXT;
ALTER TABLE documents ADD COLUMN updated_at TEXT;
UPDATE documents SET created_at = uploaded_at WHERE created_at IS NULL;
UPDATE documents SET updated_at = uploaded_at WHERE updated_at IS NULL;

-- resources — same shape as documents.
ALTER TABLE resources ADD COLUMN created_at TEXT;
ALTER TABLE resources ADD COLUMN updated_at TEXT;
UPDATE resources SET created_at = uploaded_at WHERE created_at IS NULL;
UPDATE resources SET updated_at = uploaded_at WHERE updated_at IS NULL;

-- governing_documents — backfill from effective_date (closest existing).
ALTER TABLE governing_documents ADD COLUMN created_at TEXT;
ALTER TABLE governing_documents ADD COLUMN updated_at TEXT;
UPDATE governing_documents SET created_at = effective_date WHERE created_at IS NULL;
UPDATE governing_documents SET updated_at = effective_date WHERE updated_at IS NULL;

-- ---------- Already had created_at, missing updated_at ----------

ALTER TABLE external_artifacts ADD COLUMN updated_at TEXT;
UPDATE external_artifacts SET updated_at = created_at WHERE updated_at IS NULL;

-- ---------- Config-ish tables: had updated_at, missing created_at ----------

ALTER TABLE pricing_settings ADD COLUMN created_at TEXT;
UPDATE pricing_settings SET created_at = updated_at WHERE created_at IS NULL;

ALTER TABLE filename_templates ADD COLUMN created_at TEXT;
UPDATE filename_templates SET created_at = updated_at WHERE created_at IS NULL;

ALTER TABLE quote_term_defaults ADD COLUMN created_at TEXT;
UPDATE quote_term_defaults SET created_at = updated_at WHERE created_at IS NULL;

ALTER TABLE board_user_prefs ADD COLUMN created_at TEXT;
UPDATE board_user_prefs SET created_at = updated_at WHERE created_at IS NULL;
