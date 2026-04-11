-- =====================================================================
-- Migration 0005 — Cost builds rebuilt around the calculators model
--
-- The original cost_builds/cost_lines tables from 0001 were a generic
-- "lines with categories" shape. We're replacing them with the fixed
-- 4-category pricing engine from the C-LARS calculators project:
--
--     Direct Material (DM)            target 30%
--     Direct Labor (DL)               target 25%
--     Indirect Material & Overhead    target 16%
--     Other                           target 0.5%
--     --------------------------------------------
--     Total cost                      71.5%   → 28.5% target margin
--
-- Target Price  = Total Cost / 0.715
-- Quote Price   = user-editable; blank → auto-filled from DM/DL via targets
-- Margin        = Quote - Total Cost; flagged "good" above 28.4%
--
-- Any of the four cost categories can be either (a) user-entered,
-- (b) auto-filled from the effective quote × target %, (c) in the case
-- of DM, linked to the shared dm_items library (sum of selected items),
-- or (d) in the case of DL, linked to the shared labor_items library
-- plus a per-cost-build "Current Project" workcenter breakdown.
--
-- Shared libraries (dm_items, labor_items) are global — all users see
-- the same items — matching how the calculators app works today.
--
-- This migration:
--   1. Drops the old cost_lines and cost_builds tables. No cost build
--      data exists yet on any opportunity, and no quote has ever been
--      created, so this is safe. quotes.cost_build_id still references
--      cost_builds by name and will resolve to the new table.
--   2. Creates the new cost_builds table + companion tables for DM
--      selections, labor selections, and per-build labor hours.
--   3. Creates dm_items and labor_items shared library tables.
--   4. Creates pricing_settings key/value table and seeds the defaults
--      (target percentages, default labor rate, margin threshold,
--      workcenters list).
--   5. Seeds the shared libraries with the existing data from the
--      c-lars-calculators-db project (5 DM items + 1 labor item).
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Drop the old generic cost_lines / cost_builds tables
-- ---------------------------------------------------------------------

DROP TABLE IF EXISTS cost_lines;
DROP TABLE IF EXISTS cost_builds;


-- ---------------------------------------------------------------------
-- 2. Pricing settings (key/value, simple to extend)
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pricing_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT OR REPLACE INTO pricing_settings (key, value) VALUES
  ('target_pct_dm',         '0.30'),
  ('target_pct_dl',         '0.25'),
  ('target_pct_imoh',       '0.16'),
  ('target_pct_other',      '0.005'),
  ('default_labor_rate',    '23'),
  ('margin_threshold_good', '0.284'),
  ('workcenters',           '["Fab","Paint","Mechanical","Electrical","Hydraulic","Testing","Engineering"]');


-- ---------------------------------------------------------------------
-- 3. Shared DM library
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dm_items (
  id                  TEXT PRIMARY KEY,
  description         TEXT NOT NULL DEFAULT '',
  cost                REAL NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by_user_id  TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_dm_items_created ON dm_items(created_at);


-- Seeded from the calculators database (5 rows as of 2026-04-10).
INSERT OR IGNORE INTO dm_items (id, description, cost, created_at, updated_at) VALUES
  ('68a8e0dd-9001-411f-aa0c-9298eaa27e2c', 'CTW513',             295000.00, '2026-04-09T19:34:02.789Z', '2026-04-09T19:34:11.124Z'),
  ('9e4cb751-a76c-4805-8010-6e6986aeeb48', 'CTA620',             274000.00, '2026-04-09T19:34:17.021Z', '2026-04-09T19:34:25.924Z'),
  ('cb91c813-9ab9-4b20-a340-2eb631f140d1', 'C575 Remote Spares',  99463.00, '2026-04-09T20:19:12.204Z', '2026-04-09T20:19:29.297Z'),
  ('6ee2f004-606f-4252-8497-dfb346b3028e', 'TGS Bullet',           6175.00, '2026-04-10T13:59:38.362Z', '2026-04-10T14:00:29.804Z'),
  ('d782130d-b4df-4a4b-961a-2ffac4555c6b', 'C185 Spares Q25219',  19799.46, '2026-04-10T15:27:50.179Z', '2026-04-10T15:28:08.241Z');


-- ---------------------------------------------------------------------
-- 4. Shared Labor library — item + per-workcenter entries
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS labor_items (
  id                  TEXT PRIMARY KEY,
  description         TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by_user_id  TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_labor_items_created ON labor_items(created_at);

CREATE TABLE IF NOT EXISTS labor_item_entries (
  labor_item_id       TEXT NOT NULL REFERENCES labor_items(id) ON DELETE CASCADE,
  workcenter          TEXT NOT NULL,   -- 'Fab' | 'Paint' | 'Mechanical' | 'Electrical' | 'Hydraulic' | 'Testing' | 'Engineering'
  hours               REAL NOT NULL DEFAULT 0,
  rate                REAL,            -- null → use pricing_settings.default_labor_rate
  PRIMARY KEY (labor_item_id, workcenter)
);


-- Seeded from the calculators database (1 row: TGS Bullet, 25 hrs Mechanical).
INSERT OR IGNORE INTO labor_items (id, description, created_at, updated_at) VALUES
  ('dab740d2-bed1-4b84-ac45-4fc6ab953b08', 'TGS Bullet', '2026-04-10T14:01:08.671Z', '2026-04-10T14:01:50.901Z');

INSERT OR IGNORE INTO labor_item_entries (labor_item_id, workcenter, hours, rate) VALUES
  ('dab740d2-bed1-4b84-ac45-4fc6ab953b08', 'Mechanical', 25, NULL);


-- ---------------------------------------------------------------------
-- 5. New cost_builds (one per opportunity, many allowed)
--
-- All five "user" columns are nullable — a NULL means "user has not
-- typed anything", and the server-side pricing engine auto-fills an
-- estimate based on whatever other values are present.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cost_builds (
  id                  TEXT PRIMARY KEY,
  opportunity_id      TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  label               TEXT,                            -- 'Initial estimate' | 'Post-inspection' | ...
  status              TEXT NOT NULL DEFAULT 'draft',   -- 'draft' | 'locked'

  -- Four cost category inputs. NULL = not user-set, auto-fill applies.
  dm_user_cost        REAL,
  dl_user_cost        REAL,
  imoh_user_cost      REAL,
  other_user_cost     REAL,

  -- Quote price input. NULL = not user-set.
  quote_price_user    REAL,

  -- Library linkage toggles — when on, the corresponding cost category
  -- total is derived from the sum of selected library items (DM) or
  -- library items + current-project labor (DL), overriding any user
  -- value in the "*_user_cost" column above.
  use_dm_library      INTEGER NOT NULL DEFAULT 0,
  use_labor_library   INTEGER NOT NULL DEFAULT 0,

  notes               TEXT,

  locked_at           TEXT,
  locked_by_user_id   TEXT REFERENCES users(id),

  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by_user_id  TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_cost_builds_opp ON cost_builds(opportunity_id, created_at);


-- Which DM library items does this cost build "include"?
-- Sum of their cost becomes the DM total when use_dm_library = 1.
CREATE TABLE IF NOT EXISTS cost_build_dm_selections (
  cost_build_id       TEXT NOT NULL REFERENCES cost_builds(id) ON DELETE CASCADE,
  dm_item_id          TEXT NOT NULL REFERENCES dm_items(id) ON DELETE CASCADE,
  PRIMARY KEY (cost_build_id, dm_item_id)
);


-- Which Labor library items does this cost build "include"?
-- Sum of their computed cost becomes part of DL total when use_labor_library = 1.
CREATE TABLE IF NOT EXISTS cost_build_labor_selections (
  cost_build_id       TEXT NOT NULL REFERENCES cost_builds(id) ON DELETE CASCADE,
  labor_item_id       TEXT NOT NULL REFERENCES labor_items(id) ON DELETE CASCADE,
  PRIMARY KEY (cost_build_id, labor_item_id)
);


-- Per-cost-build "Current Project" labor entry: hours+rate per workcenter.
-- One row per workcenter where the user has entered anything; missing
-- workcenters are treated as zero hours.
CREATE TABLE IF NOT EXISTS cost_build_labor (
  cost_build_id       TEXT NOT NULL REFERENCES cost_builds(id) ON DELETE CASCADE,
  workcenter          TEXT NOT NULL,
  hours               REAL NOT NULL DEFAULT 0,
  rate                REAL,
  PRIMARY KEY (cost_build_id, workcenter)
);
