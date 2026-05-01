-- =====================================================================
-- Migration 0064 — WFM import schema additions.
--
-- Adds typed columns + a wfm_payload JSON blob to every Pipeline
-- table that the WFM importer writes to, plus new tables for
-- entities that don't have a Pipeline home today (suppliers,
-- time_entries, invoices, wfm_task_templates, wfm_job_templates).
--
-- The two-tier "lose nothing" approach (per docs/wfm-mapping.md §0):
--   * Typed columns for fields actually displayed/queried in the UI
--   * wfm_payload JSON column for the full original record verbatim
--
-- All new columns are nullable so existing rows aren't disturbed.
-- Boolean-ish columns default to 0. wfm_payload is TEXT — query via
-- SQLite's json_extract() / json_each() when needed.
--
-- Skips columns that already exist in production:
--   accounts.email                — added in an earlier session
--   accounts.external_id / source — added in 0001
--   contacts.external_id / source — added in 0001
--   opportunities.external_id / source — added in 0001
--   opportunities.rfq_received_date — already populated by the BANT-lite
--                                     work; we'll write to the existing
--                                     column instead of adding rfq_received_at
--   quotes.external_id / source   — added in 0001
-- =====================================================================

-- ----- accounts -----
ALTER TABLE accounts ADD COLUMN fax                    TEXT;
ALTER TABLE accounts ADD COLUMN external_url           TEXT;
ALTER TABLE accounts ADD COLUMN account_manager_name   TEXT;
ALTER TABLE accounts ADD COLUMN referral_source        TEXT;
ALTER TABLE accounts ADD COLUMN export_code            TEXT;
ALTER TABLE accounts ADD COLUMN is_archived            INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN is_prospect            INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN is_deleted             INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN wfm_payload            TEXT;

-- ----- contacts -----
ALTER TABLE contacts ADD COLUMN salutation             TEXT;
ALTER TABLE contacts ADD COLUMN addressee              TEXT;
ALTER TABLE contacts ADD COLUMN wfm_payload            TEXT;

-- ----- opportunities (rfq_received_date already exists; reusing it) -----
ALTER TABLE opportunities ADD COLUMN wfm_category      TEXT;
ALTER TABLE opportunities ADD COLUMN wfm_type          TEXT;
ALTER TABLE opportunities ADD COLUMN external_url      TEXT;
ALTER TABLE opportunities ADD COLUMN is_hot_sheet      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE opportunities ADD COLUMN wfm_payload       TEXT;

-- ----- jobs -----
ALTER TABLE jobs ADD COLUMN external_source            TEXT;
ALTER TABLE jobs ADD COLUMN external_id                TEXT;
ALTER TABLE jobs ADD COLUMN external_url               TEXT;
ALTER TABLE jobs ADD COLUMN wfm_number                 TEXT;
ALTER TABLE jobs ADD COLUMN project_manager_user_id    TEXT REFERENCES users(id);
ALTER TABLE jobs ADD COLUMN delivery_address           TEXT;
ALTER TABLE jobs ADD COLUMN wfm_payload                TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_ext
  ON jobs(external_source, external_id) WHERE external_id IS NOT NULL;

-- ----- quotes -----
ALTER TABLE quotes ADD COLUMN wfm_number               TEXT;
ALTER TABLE quotes ADD COLUMN wfm_type                 TEXT;
ALTER TABLE quotes ADD COLUMN wfm_state                TEXT;
ALTER TABLE quotes ADD COLUMN wfm_budget               TEXT;
ALTER TABLE quotes ADD COLUMN external_url             TEXT;
ALTER TABLE quotes ADD COLUMN wfm_payload              TEXT;

-- (cost_lines: skipped — Pipeline uses cost_builds_dm_selections /
--  cost_build_labor_selections / cost_build_labor instead. The WFM
--  JobCost custom-field promotion will go onto whichever table holds
--  the line items we actually map to. Phase 1+ decision.)

-- ----- users (lookup-only enrichment — no creation) -----
ALTER TABLE users ADD COLUMN external_source           TEXT;
ALTER TABLE users ADD COLUMN external_id               TEXT;
ALTER TABLE users ADD COLUMN external_url              TEXT;
ALTER TABLE users ADD COLUMN wfm_payload               TEXT;

-- ----- documents -----
ALTER TABLE documents ADD COLUMN external_source       TEXT;
ALTER TABLE documents ADD COLUMN external_id           TEXT;
ALTER TABLE documents ADD COLUMN external_url          TEXT;
ALTER TABLE documents ADD COLUMN wfm_payload           TEXT;

-- =====================================================================
-- New tables (entities with no Pipeline home today)
-- =====================================================================

-- Suppliers — Pipeline doesn't have a normalized supplier table; this
-- holds the raw WFM Supplier records so we don't lose data.
CREATE TABLE IF NOT EXISTS suppliers (
  id              TEXT PRIMARY KEY,
  external_source TEXT,
  external_id     TEXT,
  external_url    TEXT,
  name            TEXT NOT NULL,
  email           TEXT,
  phone           TEXT,
  website         TEXT,
  address         TEXT,
  is_archived     INTEGER NOT NULL DEFAULT 0,
  wfm_payload     TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_ext
  ON suppliers(external_source, external_id) WHERE external_id IS NOT NULL;

-- Time entries — minimal table for full-fidelity import.
CREATE TABLE IF NOT EXISTS time_entries (
  id              TEXT PRIMARY KEY,
  external_source TEXT,
  external_id     TEXT,
  staff_user_id   TEXT REFERENCES users(id),
  job_external_id TEXT,
  date            TEXT,
  minutes         INTEGER,
  billable        INTEGER NOT NULL DEFAULT 0,
  note            TEXT,
  wfm_payload     TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_time_entries_ext
  ON time_entries(external_source, external_id) WHERE external_id IS NOT NULL;

-- Invoices — minimal table.
CREATE TABLE IF NOT EXISTS invoices (
  id                   TEXT PRIMARY KEY,
  external_source      TEXT,
  external_id          TEXT,
  external_url         TEXT,
  wfm_number           TEXT,
  wfm_type             TEXT,
  wfm_status           TEXT,
  account_id           TEXT REFERENCES accounts(id),
  contact_id           TEXT REFERENCES contacts(id),
  job_external_id      TEXT,
  date                 TEXT,
  due_date             TEXT,
  amount               REAL,
  amount_tax           REAL,
  amount_including_tax REAL,
  amount_paid          REAL,
  amount_outstanding   REAL,
  description          TEXT,
  wfm_payload          TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_ext
  ON invoices(external_source, external_id) WHERE external_id IS NOT NULL;

-- Task templates — the WFM "WELDING / ENGINEERING / COATINGS" catalog.
CREATE TABLE IF NOT EXISTS wfm_task_templates (
  id              TEXT PRIMARY KEY,
  external_id     TEXT UNIQUE,
  name            TEXT NOT NULL,
  description     TEXT,
  wfm_payload     TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Job templates — the WFM "NEW MANUFACTURING / REFURB WINCH / etc." catalog.
CREATE TABLE IF NOT EXISTS wfm_job_templates (
  id              TEXT PRIMARY KEY,
  external_id     TEXT UNIQUE,
  name            TEXT NOT NULL,
  wfm_payload     TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- =====================================================================
-- WFM credentials store (single-row "config" table)
--
-- The Node-side scripts read OAuth credentials from .env.local; the
-- server-side importer can't do that. WFM_CLIENT_ID and
-- WFM_CLIENT_SECRET are static and live in Cloudflare Pages secrets;
-- WFM_REFRESH_TOKEN rotates with every refresh and lives here so the
-- server can persist updates between requests.
-- =====================================================================

CREATE TABLE IF NOT EXISTS wfm_credentials (
  id              INTEGER PRIMARY KEY CHECK (id = 1),  -- single-row table
  refresh_token   TEXT,
  access_token    TEXT,                                -- cached for ~30 min
  access_expires_at TEXT,
  org_id          TEXT,                                -- extracted from the JWT
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Seed the single row so subsequent UPDATEs always have a target.
INSERT INTO wfm_credentials (id) VALUES (1)
  ON CONFLICT(id) DO NOTHING;
