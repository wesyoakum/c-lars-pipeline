-- =====================================================================
-- Migration 0071 — Katana sales-order linkage on quotes.
--
-- Phase 2c. When the admin clicks "Push to Katana" on a quote, the
-- handler creates a Katana sales order with one row per milestone and
-- stores the returned id here. Subsequent visits to the quote page
-- read this column to swap the "Push" button for an "Already pushed"
-- badge.
--
-- Two columns:
--   * katana_sales_order_id   (INTEGER) — the id Katana returns from
--     POST /sales_orders. NULL while not pushed.
--   * katana_sales_order_pushed_at (TEXT) — ISO timestamp when the
--     push happened. Useful for audit trail without needing to read
--     the audit_log table.
--
-- Idempotency rule (enforced in the route handler, not the schema):
-- Re-pushing a quote with a non-null katana_sales_order_id is blocked
-- unless the user explicitly unlinks first. This avoids accidental
-- duplicate sales orders in Katana.
-- =====================================================================

ALTER TABLE quotes ADD COLUMN katana_sales_order_id        INTEGER;
ALTER TABLE quotes ADD COLUMN katana_sales_order_pushed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_quotes_katana_sales_order
  ON quotes(katana_sales_order_id)
  WHERE katana_sales_order_id IS NOT NULL;
