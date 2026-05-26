-- R2-backed WFM snapshots — metadata index.
-- Actual data lives in R2 under wfm-snapshots/{id}/{kind}.json.
-- The existing wfm_import_snapshots table (per-entity merge base for
-- 3-way diff) is intentionally kept — it serves a different purpose.

CREATE TABLE IF NOT EXISTS wfm_snapshots (
  id              TEXT PRIMARY KEY,
  created_at      TEXT NOT NULL,
  created_by      TEXT,
  parent_id       TEXT,
  status          TEXT NOT NULL DEFAULT 'fetching',
  counts_json     TEXT NOT NULL DEFAULT '{}',
  duration_ms     INTEGER,
  error           TEXT,
  diff_run_id     TEXT
);

CREATE INDEX IF NOT EXISTS wfm_snapshots_created_idx
  ON wfm_snapshots(created_at DESC);
