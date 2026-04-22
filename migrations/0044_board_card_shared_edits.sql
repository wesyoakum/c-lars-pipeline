-- =====================================================================
-- Migration 0044: Board-card shared edits.
--
-- Post-it cards shared with another user (scope='direct', target_user_id
-- set) can now be edited by the recipient. To distinguish the recipient's
-- edits from the author's original text, we track the last editor and
-- render the card text in blue when the last editor isn't the author.
--
--   board_cards.last_edited_by_user_id TEXT REFERENCES users(id)
--     NULL → never edited after creation (author's original text).
--     == author_user_id → author has edited their own card (normal).
--     != author_user_id → non-author (recipient or admin) edited the
--       card; client renders the body in blue so the original author
--       can tell what a recipient changed.
-- =====================================================================

ALTER TABLE board_cards
  ADD COLUMN last_edited_by_user_id TEXT REFERENCES users(id);
