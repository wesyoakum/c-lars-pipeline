-- =====================================================================
-- Migration 0075 — per-quote-type payment-schedule defaults.
--
-- Step 4 of the Katana rebuild. Each quote type (eps, spares,
-- refurb_baseline, refurb_modified, refurb_supplemental, service) can
-- have its own default milestone schedule. The "Copy from type
-- default" button on the per-quote schedule editor pulls from here.
-- A new admin-only "Set as default" button writes the current quote's
-- schedule back into this table.
--
-- Single-row-per-type design — quote_type is the primary key. Mirrors
-- the pattern of quote_term_defaults (migration 0024).
--
-- The schedule_json shape matches lib/quote-payment-schedule.js:
--   { "rows": [{ percent, weeks?, label, katana_variant_id?, katana_sku? }] }
-- =====================================================================

CREATE TABLE IF NOT EXISTS quote_payment_schedule_defaults (
  quote_type     TEXT PRIMARY KEY,
  schedule_json  TEXT NOT NULL,
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by     TEXT REFERENCES users(id)
);
