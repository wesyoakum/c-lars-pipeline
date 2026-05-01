-- =====================================================================
-- Migration 0070 — Katana customer mapping on accounts.
--
-- Phase 2b of the Katana integration. The /settings/katana-customer-map
-- workbench lets admins pair every Pipeline account with the
-- corresponding Katana customer (or create a new one in Katana on the
-- spot). Required prep work before Phase 2c (push won opportunity ->
-- Katana sales order), since the SO needs a customer_id and Katana's
-- customer-name shorthand doesn't match Pipeline's legal account name
-- one-to-one.
--
-- Why two columns:
--   * katana_customer_id (INTEGER) — durable primary key from Katana.
--     This is what we send on POST /sales_orders. Set once at link
--     time, never changes unless the user explicitly re-links.
--   * katana_customer_name (TEXT) — Katana's short-code name (e.g.
--     "ROVOP", "WASSOC", "DEEP OCEAN"). Stored alongside the id purely
--     for human readability in Pipeline lists / detail pages — saves a
--     Katana round-trip just to display "linked to Katana customer X".
-- =====================================================================

ALTER TABLE accounts ADD COLUMN katana_customer_id   INTEGER;
ALTER TABLE accounts ADD COLUMN katana_customer_name TEXT;

CREATE INDEX IF NOT EXISTS idx_accounts_katana_customer
  ON accounts(katana_customer_id)
  WHERE katana_customer_id IS NOT NULL;
