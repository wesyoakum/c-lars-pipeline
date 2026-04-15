-- 0028_opportunities_drop_stage_fk.sql
--
-- Drop the composite FK `opportunities (transaction_type, stage) →
-- stage_definitions (transaction_type, stage_key)`.
--
-- Why:
--   `transaction_type` now accepts comma-separated values (e.g.
--   "spares,service") for multi-type opportunities, but the FK can
--   only match single rows like ('spares','lead') or ('service','lead').
--   Inserting a multi-type opp therefore throws a FOREIGN KEY constraint
--   failure and surfaces as a Cloudflare Workers 1101 (unhandled
--   exception) to the user.
--
--   Stage validity is already enforced at the application layer via
--   lib/stages.js + validateStageTransition, so losing the DB-level
--   check is not a regression — it only bites when someone INSERTs
--   directly to D1, which we don't do.
--
-- SQLite can't DROP a FOREIGN KEY in place. We rebuild the table:
--   1. Disable FK enforcement (required because 6 child tables reference
--      opportunities.id — quotes, jobs, activities, documents,
--      external_artifacts, cost_builds — and SQLite would otherwise
--      cascade-delete them all when we DROP opportunities).
--   2. Create opportunities_new with every current column EXCEPT the
--      composite FK at the bottom.
--   3. Copy all rows.
--   4. Drop the old table.
--   5. Rename the new table into place.
--   6. Recreate the 6 named indexes that lived on the old table.
--   7. Re-enable FK enforcement.

PRAGMA foreign_keys = OFF;

CREATE TABLE opportunities_new (
  id                        TEXT PRIMARY KEY,
  number                    TEXT NOT NULL UNIQUE,
  account_id                TEXT NOT NULL REFERENCES accounts(id),
  primary_contact_id        TEXT REFERENCES contacts(id),
  title                     TEXT NOT NULL,
  description               TEXT,
  transaction_type          TEXT NOT NULL,
  stage                     TEXT NOT NULL,
  stage_entered_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  probability               INTEGER,
  estimated_value_usd       REAL,
  currency                  TEXT NOT NULL DEFAULT 'USD',
  expected_close_date       TEXT,
  actual_close_date         TEXT,
  source                    TEXT,
  rfq_format                TEXT,
  bant_budget               TEXT,
  bant_authority            TEXT,
  bant_need                 TEXT,
  bant_timeline             TEXT,
  close_reason              TEXT,
  loss_reason_tag           TEXT,
  owner_user_id             TEXT REFERENCES users(id),
  salesperson_user_id       TEXT REFERENCES users(id),
  external_source           TEXT,
  external_id               TEXT,
  created_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by_user_id        TEXT REFERENCES users(id),
  bant_authority_contact_id TEXT REFERENCES contacts(id),
  rfq_received_date         TEXT,
  rfq_due_date              TEXT,
  rfi_due_date              TEXT,
  quoted_date               TEXT,
  customer_po_number        TEXT
  -- Intentionally NO composite FK on (transaction_type, stage).
);

INSERT INTO opportunities_new (
  id, number, account_id, primary_contact_id, title, description,
  transaction_type, stage, stage_entered_at, probability,
  estimated_value_usd, currency,
  expected_close_date, actual_close_date,
  source, rfq_format,
  bant_budget, bant_authority, bant_need, bant_timeline,
  close_reason, loss_reason_tag,
  owner_user_id, salesperson_user_id,
  external_source, external_id,
  created_at, updated_at, created_by_user_id,
  bant_authority_contact_id,
  rfq_received_date, rfq_due_date, rfi_due_date, quoted_date,
  customer_po_number
)
SELECT
  id, number, account_id, primary_contact_id, title, description,
  transaction_type, stage, stage_entered_at, probability,
  estimated_value_usd, currency,
  expected_close_date, actual_close_date,
  source, rfq_format,
  bant_budget, bant_authority, bant_need, bant_timeline,
  close_reason, loss_reason_tag,
  owner_user_id, salesperson_user_id,
  external_source, external_id,
  created_at, updated_at, created_by_user_id,
  bant_authority_contact_id,
  rfq_received_date, rfq_due_date, rfi_due_date, quoted_date,
  customer_po_number
FROM opportunities;

DROP TABLE opportunities;

ALTER TABLE opportunities_new RENAME TO opportunities;

-- Recreate the indexes that were dropped with the old table. The
-- PRIMARY KEY and UNIQUE autoindexes are recreated automatically.
CREATE INDEX IF NOT EXISTS idx_opportunities_account    ON opportunities(account_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_stage      ON opportunities(transaction_type, stage);
CREATE INDEX IF NOT EXISTS idx_opportunities_owner      ON opportunities(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_updated    ON opportunities(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_opportunities_rfq_format ON opportunities(rfq_format);
CREATE UNIQUE INDEX IF NOT EXISTS idx_opportunities_ext
  ON opportunities(external_source, external_id)
  WHERE external_id IS NOT NULL;

PRAGMA foreign_keys = ON;
