-- =====================================================================
-- Migration 0070 — persisted log of WFM import runs.
--
-- Currently the /settings/wfm-import workbench shows the result of an
-- import (counts, links, errors) only in the in-page modal. Reload the
-- page and the trail vanishes — no way to look up "which quotes did I
-- try last week and which skipped." This table fixes that.
--
-- One row per call to /settings/wfm-import/commit. Captures:
--   - who/when
--   - what was attempted (selection_summary_json: light array of
--     {kind, id, uuid, name} per submitted record — full WFM payloads
--     stay out to keep row size sane)
--   - what happened (counts_json, summary, errors_json, links_json)
--   - whether the commit returned ok=true overall (per-record errors
--     can still appear with ok=true if some rows skipped)
-- =====================================================================

CREATE TABLE IF NOT EXISTS wfm_import_runs (
  id                       TEXT PRIMARY KEY,
  started_at               TEXT NOT NULL,
  finished_at              TEXT,
  triggered_by             TEXT,                 -- user email at run time
  ok                       INTEGER NOT NULL DEFAULT 0,
  summary                  TEXT,                 -- human-readable result line
  counts_json              TEXT,                 -- JSON object of counters
  errors_json              TEXT,                 -- JSON array of strings
  links_json               TEXT,                 -- JSON array of {url,label}
  selection_summary_json   TEXT,                 -- JSON array of {kind,id,uuid,name}
  selection_size           INTEGER NOT NULL DEFAULT 0,
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_wfm_import_runs_started
  ON wfm_import_runs(started_at DESC);
