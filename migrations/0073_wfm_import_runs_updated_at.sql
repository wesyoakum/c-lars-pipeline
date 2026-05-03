-- =====================================================================
-- Migration 0073 — add updated_at to wfm_import_runs.
--
-- The cron step's updateRunProgress() helper (functions/api/cron/
-- wfm-step.js) was written to set updated_at on every chunk so the
-- /full/status endpoint and the history page could show "last
-- touched" age. But migration 0070 created wfm_import_runs without
-- an updated_at column, and migration 0071 (the timestamp audit)
-- skipped this table. Result: every cron tick that tried to advance
-- a full-import run threw "no such column: updated_at" and silently
-- did nothing — the queue stayed at 100% pending.
--
-- Fix: add the column, backfill from started_at (or finished_at where
-- the run already wrapped). Code is unchanged — it now matches the
-- schema.
-- =====================================================================

ALTER TABLE wfm_import_runs ADD COLUMN updated_at TEXT;

-- Backfill: prefer finished_at (terminal) over started_at (mid-flight).
UPDATE wfm_import_runs
   SET updated_at = COALESCE(finished_at, started_at, created_at)
 WHERE updated_at IS NULL;
