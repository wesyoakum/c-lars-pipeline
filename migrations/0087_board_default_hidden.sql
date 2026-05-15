-- 0087_board_default_hidden.sql
--
-- The board sidebar (right To-Do/Notes + left Messages panels) now
-- defaults to hidden for everyone. Visibility is driven by the
-- board_user_prefs.hidden_until snooze timestamp; a far-future sentinel
-- ('2999-12-31T23:59:59.000Z') encodes "hidden indefinitely / by
-- default" with no schema change (see functions/lib/board.js
-- BOARD_DEFAULT_HIDDEN_UNTIL and its js/board-sidebar.js mirror).
--
-- This is a one-time reset: every existing user's board is collapsed
-- right now. Their module order and per-module collapse state are
-- untouched. A user can still click the restore button (next to the
-- notification bell) to reopen it, which persists hidden_until=NULL and
-- keeps it open for them across loads.

UPDATE board_user_prefs
   SET hidden_until = '2999-12-31T23:59:59.000Z',
       updated_at   = '2026-05-15T00:00:00.000Z';
