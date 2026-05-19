-- =====================================================================
-- Migration 0071 — MRPeasy API credentials (single-row config table).
--
-- MRPeasy is the MRP/ERP C-LARS used before WorkflowMax. The account
-- is frozen (no new data) but we want everything out of it. Unlike
-- WFM/BlueRock's OAuth, MRPeasy uses static HTTP Basic auth:
--   Authorization: Basic base64(api-key : api-secret)
-- Both come from MRPeasy → Settings → Integration → API access.
--
-- Single row (id = 1), mirrors wfm_credentials. No token rotation —
-- the key/secret are static until the user regenerates them in
-- MRPeasy, so there's nothing to refresh.
-- =====================================================================

CREATE TABLE IF NOT EXISTS mrpeasy_credentials (
  id                INTEGER PRIMARY KEY CHECK (id = 1),  -- single-row table
  api_key           TEXT,
  api_secret        TEXT,
  api_base          TEXT,    -- override; defaults to app.mrpeasy.com/rest/v1 in code
  last_verified_at  TEXT,    -- set when a connection test last succeeded
  last_export_at    TEXT,    -- set when a raw export last completed
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Seed the single row so subsequent UPDATEs always have a target.
INSERT INTO mrpeasy_credentials (id) VALUES (1)
  ON CONFLICT(id) DO NOTHING;

-- Persisted log of raw-export runs (mirrors wfm_import_runs). One row
-- per /settings/mrpeasy-import/export invocation.
CREATE TABLE IF NOT EXISTS mrpeasy_export_runs (
  id                TEXT PRIMARY KEY,
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  triggered_by      TEXT,                  -- user email at run time
  ok                INTEGER NOT NULL DEFAULT 0,
  r2_prefix         TEXT,                  -- mrpeasy-export/<run-id>/
  summary           TEXT,                  -- human-readable result line
  manifest_json     TEXT,                  -- per-entity counts + timing + errors
  errors_json       TEXT,                  -- JSON array of strings
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_mrpeasy_export_runs_started
  ON mrpeasy_export_runs(started_at DESC);
