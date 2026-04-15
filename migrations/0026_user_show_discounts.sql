-- Migration 0026 — Per-user "show discounts" preference
--
-- Adds a per-user toggle controlling whether the discount UI is
-- rendered on quote pages (header discount row + per-line discount
-- editor) and in price-build pricing tabs. When off, the fields are
-- hidden everywhere but stored data is preserved and still flows
-- through totals / PDF generation. Default ON for backward compat.
--
-- Managed via the new /settings page (gear icon in the header).

ALTER TABLE users ADD COLUMN show_discounts INTEGER NOT NULL DEFAULT 1;
