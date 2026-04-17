-- Migration 0036 — Site-wide display-preference defaults
--
-- Adds a single-row `site_prefs` table that mirrors the per-user
-- display-preference columns on `users` (show_alias, group_rollup,
-- active_only — see migrations 0034, 0035). The row is the canonical
-- "new user starts here" state and the target for two actions in the
-- gear-icon popup:
--
--   * Reset to defaults    (any user) — copies site_prefs into the
--                          current user's prefs columns.
--   * Save current as
--     defaults             (admin)    — copies the admin's current
--                          prefs into site_prefs.
--
-- The middleware's upsertUser() reads this row on first-time INSERT
-- of a new user so they land with the admin-blessed defaults
-- instead of the column DEFAULT 0 fallbacks.
--
-- Single-row pattern: we force id = 1 with a CHECK constraint and
-- seed that row in this migration. No UI ever inserts/deletes rows
-- here; actions only UPDATE the existing row.
--
-- Seeded values reflect wes.yoakum@c-lars.com's working setup at
-- the time of this migration (all three on). Admins can re-capture
-- later via "Save current as defaults" in the popup.

CREATE TABLE IF NOT EXISTS site_prefs (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  show_alias   INTEGER NOT NULL DEFAULT 0,
  group_rollup INTEGER NOT NULL DEFAULT 0,
  active_only  INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT,
  updated_by   TEXT
);

INSERT OR IGNORE INTO site_prefs (id, show_alias, group_rollup, active_only, updated_at, updated_by)
VALUES (1, 1, 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'user-wes-yoakum');

-- Apply the seeded defaults to the existing WFM-import stub users
-- (Kat, Sara, Adam) so their first real login lands with the same
-- view Wes has today. Wes's row is left alone because the seed row
-- above was copied from his values. Any future users created by
-- upsertUser() will pick up site_prefs too.
UPDATE users
SET show_alias = 1,
    group_rollup = 1,
    active_only = 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id IN ('user-kat-deno', 'user-sara-patterson', 'user-adam-janac');
