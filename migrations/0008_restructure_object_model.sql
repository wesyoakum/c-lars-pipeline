-- 0008_restructure_object_model.sql
--
-- Major restructure: price builds move under quote line items,
-- new Items Library + Builds Library tables, jobs link to quotes.
--
-- Object hierarchy after this migration:
--   Account
--    ├── Opportunity
--    │     ├── Quotes
--    │     │     ├── Line Items → items_library
--    │     │     │     ├── Price Builds (cost_builds) → builds_library
--    │     │     │     │     ├── DM Selections → dm_items
--    │     │     │     │     └── DL Selections → labor_items
--    │     │     │     └── Documents
--    │     │     ├── Documents
--    │     │     └── Jobs
--    │     ├── Activities
--    │     └── Documents
--    ├── Contact
--    └── Documents

-- ──────────────────────────────────────────────────────────────────
-- 1. Items Library — shared catalog of products/services
-- ──────────────────────────────────────────────────────────────────

CREATE TABLE items_library (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  default_unit    TEXT DEFAULT 'ea',
  default_price   REAL DEFAULT 0,
  category        TEXT,           -- free-text grouping
  notes           TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_items_library_name ON items_library(name);
CREATE INDEX idx_items_library_category ON items_library(category);

-- ──────────────────────────────────────────────────────────────────
-- 2. Builds Library — reusable price build templates
-- ──────────────────────────────────────────────────────────────────

CREATE TABLE builds_library (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT,
  -- Same pricing fields as cost_builds
  dm_user_cost      REAL,
  dl_user_cost      REAL,
  imoh_user_cost    REAL,
  other_user_cost   REAL,
  quote_price_user  REAL,
  use_dm_library    INTEGER NOT NULL DEFAULT 0,
  use_labor_library INTEGER NOT NULL DEFAULT 0,
  notes             TEXT,
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE builds_library_dm_selections (
  builds_library_id TEXT NOT NULL REFERENCES builds_library(id) ON DELETE CASCADE,
  dm_item_id        TEXT NOT NULL REFERENCES dm_items(id) ON DELETE CASCADE,
  PRIMARY KEY (builds_library_id, dm_item_id)
);

CREATE TABLE builds_library_labor_selections (
  builds_library_id TEXT NOT NULL REFERENCES builds_library(id) ON DELETE CASCADE,
  labor_item_id     TEXT NOT NULL REFERENCES labor_items(id) ON DELETE CASCADE,
  PRIMARY KEY (builds_library_id, labor_item_id)
);

CREATE TABLE builds_library_labor (
  builds_library_id TEXT NOT NULL REFERENCES builds_library(id) ON DELETE CASCADE,
  workcenter        TEXT NOT NULL,
  hours             REAL NOT NULL DEFAULT 0,
  rate              REAL,
  PRIMARY KEY (builds_library_id, workcenter)
);

-- ──────────────────────────────────────────────────────────────────
-- 3. Link cost_builds (price builds) to quote line items
--    New line-level builds set quote_line_id + opportunity_id.
--    Old opp-level builds have quote_line_id = NULL.
-- ──────────────────────────────────────────────────────────────────

ALTER TABLE cost_builds ADD COLUMN quote_line_id TEXT REFERENCES quote_lines(id);
ALTER TABLE cost_builds ADD COLUMN builds_library_id TEXT REFERENCES builds_library(id);

-- ──────────────────────────────────────────────────────────────────
-- 4. Link quote_lines to items library
-- ──────────────────────────────────────────────────────────────────

ALTER TABLE quote_lines ADD COLUMN item_library_id TEXT REFERENCES items_library(id);

-- ──────────────────────────────────────────────────────────────────
-- 5. Link jobs to quotes (jobs are execution of won quotes)
-- ──────────────────────────────────────────────────────────────────

ALTER TABLE jobs ADD COLUMN quote_id TEXT REFERENCES quotes(id);
