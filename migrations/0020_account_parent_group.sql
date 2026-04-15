-- 0020_account_parent_group.sql
--
-- Label-based parent/child account grouping.
--
-- `parent_group` is a free-text label (e.g. "Super Big Corp") that
-- multiple real accounts can share. It is NOT a foreign key — we
-- deliberately avoid a second "pseudo-parent" accounts row with
-- empty contacts/addresses/opportunities. Instead, a synthetic
-- /accounts/group/:slug view queries every account with the same
-- label and rolls up their contacts + opportunities on demand.
--
-- Why a label and not a FK:
--   * No orphan handling when the group is renamed or deleted.
--   * No conflict resolution between "parent" and "child" contacts,
--     addresses, terms — data stays on the real account rows.
--   * Adding/removing an account from a group is one text update.
--
-- The index speeds up both the sibling sidebar on the account detail
-- page and the synthetic group rollup query.

ALTER TABLE accounts ADD COLUMN parent_group TEXT;
CREATE INDEX IF NOT EXISTS idx_accounts_parent_group ON accounts(parent_group);
