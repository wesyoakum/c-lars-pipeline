-- =====================================================================
-- Migration 0073 — per-line Katana sales-order linkage.
--
-- Step 2 of the incremental Katana rebuild. The push model changes
-- from "one Katana SO per quote (with N milestone rows from quote
-- total)" to "one Katana SO per quote LINE (each with N milestone
-- rows from that line's extended price)". Mirrors Adam's existing
-- D079 pattern in Katana: a single project becomes multiple sales
-- orders, one per major equipment item.
--
-- Three new columns on quote_lines:
--   * katana_sales_order_id   INTEGER — the SO id Katana returns from
--     POST /sales_orders for THIS line. NULL when the line hasn't
--     been pushed yet. Idempotency: a line with a non-null id is
--     skipped on subsequent pushes (the existing /katana-unlink route
--     clears it line-wide, allowing re-push).
--   * katana_sales_order_pushed_at TEXT — ISO timestamp of the push.
--     Useful for audit trail without touching audit_log.
--   * katana_push_error TEXT — populated when the per-line POST
--     fails. Other lines still push; the error is visible inline on
--     the quote detail page so the user knows which lines need
--     attention.
--
-- The existing quotes.katana_sales_order_id (from migration 0071) is
-- now dormant — left in place for any rows that pushed under the old
-- single-SO model. A future cleanup migration can drop it once we're
-- confident.
-- =====================================================================

ALTER TABLE quote_lines ADD COLUMN katana_sales_order_id        INTEGER;
ALTER TABLE quote_lines ADD COLUMN katana_sales_order_pushed_at TEXT;
ALTER TABLE quote_lines ADD COLUMN katana_push_error            TEXT;

CREATE INDEX IF NOT EXISTS idx_quote_lines_katana_so
  ON quote_lines(katana_sales_order_id)
  WHERE katana_sales_order_id IS NOT NULL;
