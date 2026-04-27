-- Migration 0049 — Messaging feature kill-switch
--
-- Adds a `messaging_enabled` flag to the single-row site_prefs table
-- that gates the "Message Everyone" sidebar (BOARD_LEFT_MARKUP in
-- functions/lib/layout.js) and the POST /board/cards endpoint when
-- scope='direct'.
--
-- DEFAULT 0 — the feature ships disabled. The existing site_prefs
-- row inherits 0 from the column default, so messaging is hidden
-- for everyone immediately on deploy. An admin enables it from
-- /settings → Features → Team messaging when ready.
--
-- Note: the right-side board (post-it notes / blockers) is a
-- different feature and is *not* affected by this flag.

ALTER TABLE site_prefs ADD COLUMN messaging_enabled INTEGER NOT NULL DEFAULT 0;
