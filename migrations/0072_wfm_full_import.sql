-- =====================================================================
-- Migration 0072 — WFM full-import background queue (Option 3).
--
-- Adds a per-record work queue (wfm_import_plans) that lets a full
-- import advance one chunk at a time, driven by the existing cron
-- Worker. The browser only kicks the run off and polls for progress;
-- the actual record-by-record work happens in cron ticks, so the
-- import survives tab closes / browser crashes / sleep.
--
-- Existing wfm_import_runs is reused — a "selective" run (the existing
-- one-shot /commit flow) gets one row, completed immediately. A "full"
-- run gets one row in mode='full', plus N wfm_import_plans rows that
-- the cron drains.
-- =====================================================================

-- Per-run metadata. Existing runs default to mode='selective' /
-- status='completed' so the history page keeps rendering them as
-- before.
ALTER TABLE wfm_import_runs ADD COLUMN mode          TEXT NOT NULL DEFAULT 'selective';
ALTER TABLE wfm_import_runs ADD COLUMN status        TEXT NOT NULL DEFAULT 'completed';
ALTER TABLE wfm_import_runs ADD COLUMN options_json  TEXT;
ALTER TABLE wfm_import_runs ADD COLUMN total_planned INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_wfm_import_runs_status_mode
  ON wfm_import_runs(status, mode);

-- Work queue. One row per WFM record in a full-import run. Cron
-- picks up status='pending' rows, marks them 'processing', runs the
-- per-record import, then sets 'done' (or 'error' with a message).
-- 'cancelled' is set when the user aborts mid-run.
CREATE TABLE IF NOT EXISTS wfm_import_plans (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  sequence        INTEGER NOT NULL,        -- ordering: kinds in dependency order, then position-in-list
  kind            TEXT NOT NULL,           -- 'staff'|'client'|'lead'|'quote'|'job'
  external_uuid   TEXT NOT NULL,           -- WFM UUID
  record_json     TEXT NOT NULL,           -- full WFM record snapshot at planning time
  status          TEXT NOT NULL DEFAULT 'pending',
  error_message   TEXT,
  started_at      TEXT,
  finished_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_wfm_import_plans_run_seq
  ON wfm_import_plans(run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_wfm_import_plans_status_run
  ON wfm_import_plans(status, run_id, sequence);
