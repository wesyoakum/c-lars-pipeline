-- 0033_board_cards_sort_order.sql
--
-- Adds a per-card sort_order (REAL) to support manual drag-to-reorder
-- in the right-sidebar Notes zone. REAL (not INTEGER) so the client
-- can drop a card between two neighbors by writing the midpoint of
-- their sort_orders, no renumber pass required.
--
-- Convention: HIGHER sort_order = closer to top.
-- New rows get sort_order = epoch milliseconds at insert time, so
-- "newest first" remains the default ordering for never-dragged cards.
-- Existing rows are backfilled from their created_at so the snapshot
-- after migration matches the snapshot before it.
--
-- Drag affordance is currently scoped to private cards only (see
-- frontend) so a user reordering their own notepad never affects
-- what other users see in their Shared Board.

ALTER TABLE board_cards ADD COLUMN sort_order REAL;

-- Backfill: convert created_at (ISO-8601 text) to epoch ms.
-- strftime('%s', t) returns epoch seconds as text → cast to REAL → × 1000.
UPDATE board_cards
   SET sort_order = CAST(strftime('%s', created_at) AS REAL) * 1000.0
 WHERE sort_order IS NULL
   AND created_at IS NOT NULL;
