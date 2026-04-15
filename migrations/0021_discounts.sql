-- 0021_discounts.sql
--
-- Discount support at three levels:
--   1. Quote header  (on `quotes`)      — reduces the quote's grand total
--   2. Quote line    (on `quote_lines`) — reduces an individual line
--   3. Price build   (on `cost_builds`) — flows through to the quote line
--                                         that is linked to the build
--
-- All four columns are identical across tables so the compute helpers
-- in functions/lib/pricing.js can operate on any of them uniformly.
--
-- Semantics:
--   discount_amount       — flat dollar amount to deduct. Wins over pct.
--   discount_pct          — percentage in 0..100, applied to the scope.
--                           For header: subtotal. For line: qty*unit_price.
--                           For build: build price before discount.
--   discount_description  — customer-facing label ("Volume discount",
--                           "Preferred partner 15%", etc.). Rendered on
--                           the PDF as the discount line's description.
--   discount_is_phantom   — 0/1 flag. When set, the discount is NOT
--                           subtracted from the stored totals. Instead
--                           the unit_price is marked up at render time
--                           so the PDF shows an inflated price and a
--                           matching discount line, landing at the real
--                           revenue figure. Used for customers who want
--                           to "see the discount" without C-LARS
--                           actually giving up margin.
--
-- All columns are nullable so existing rows behave identically until a
-- discount is set. Phase 1 (this commit) wires the header-level fields
-- into the quote detail UI. Phases 2 and 3 wire up line + build later
-- without requiring another migration.

ALTER TABLE quotes      ADD COLUMN discount_amount      REAL;
ALTER TABLE quotes      ADD COLUMN discount_pct         REAL;
ALTER TABLE quotes      ADD COLUMN discount_description TEXT;
ALTER TABLE quotes      ADD COLUMN discount_is_phantom  INTEGER NOT NULL DEFAULT 0;

ALTER TABLE quote_lines ADD COLUMN discount_amount      REAL;
ALTER TABLE quote_lines ADD COLUMN discount_pct         REAL;
ALTER TABLE quote_lines ADD COLUMN discount_description TEXT;
ALTER TABLE quote_lines ADD COLUMN discount_is_phantom  INTEGER NOT NULL DEFAULT 0;

ALTER TABLE cost_builds ADD COLUMN discount_amount      REAL;
ALTER TABLE cost_builds ADD COLUMN discount_pct         REAL;
ALTER TABLE cost_builds ADD COLUMN discount_description TEXT;
ALTER TABLE cost_builds ADD COLUMN discount_is_phantom  INTEGER NOT NULL DEFAULT 0;
