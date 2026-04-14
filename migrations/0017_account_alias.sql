-- Migration 0017 — Account aliases / nicknames
--
-- Adds a free-text `alias` column to `accounts` so Wes can tag long
-- legal names with a short everyday nickname (e.g. "Helix" for "Helix
-- Robotics Inc.", "C-I" for "Creative Industries LLC"). The alias is
-- displayed alongside the name in list views and pickers, and is
-- included in quicksearch data attributes so you can filter by either.

ALTER TABLE accounts ADD COLUMN alias TEXT;
CREATE INDEX IF NOT EXISTS idx_accounts_alias ON accounts(alias);
