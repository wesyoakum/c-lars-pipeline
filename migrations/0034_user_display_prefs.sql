-- Migration 0034 — Per-user display preferences (alias display + group rollup)
--
-- Two new per-user toggles, both default OFF for back-compat:
--
--   show_alias    When 1, the UI displays accounts.alias instead of
--                 accounts.name in lists, columns, dropdowns, picker
--                 modals, board, and mention search. Sorting and
--                 filtering follow the displayed value.
--
--   group_rollup  When 1, accounts that share a parent_group label
--                 collapse on the Accounts list into a single row per
--                 group (with summed counts) linking to
--                 /accounts/group/:slug. On entity lists (Opportunities,
--                 Quotes, Jobs, Activities, Board) the "Account" column
--                 shows the group label for grouped accounts, and
--                 creating a new opp/quote/task triggers a two-stage
--                 picker: pick group, then pick the actual member
--                 account whose id is stored on the new entity.
--
-- Managed via the gear-icon settings popup in the top header.
--
-- Also: backfill accounts.alias = name wherever alias is NULL or
-- empty, so the "show aliases" toggle never produces a blank cell.
-- The application layer (accounts/new.js, accounts/[id]/patch.js,
-- WFM federation) is responsible for keeping alias non-empty going
-- forward; SQLite cannot retroactively add a NOT NULL constraint.

ALTER TABLE users ADD COLUMN show_alias INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN group_rollup INTEGER NOT NULL DEFAULT 0;

UPDATE accounts SET alias = name WHERE alias IS NULL OR alias = '';
