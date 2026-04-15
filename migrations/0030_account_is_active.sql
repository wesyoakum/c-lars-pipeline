-- 0030_account_is_active.sql
--
-- Add an Active/Inactive flag to accounts. `is_active` is a soft status:
-- inactive accounts stay in the DB (so historical opportunities, quotes
-- and jobs still resolve through their account_id FKs) but the list-table
-- Status column lets users filter them out of their day-to-day view.
--
-- New accounts default to Active. Existing rows are backfilled to
-- Active via the NOT NULL DEFAULT 1.

ALTER TABLE accounts ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_accounts_is_active ON accounts(is_active);
