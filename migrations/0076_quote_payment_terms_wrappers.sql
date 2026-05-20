-- =====================================================================
-- Migration 0076 — payment-terms wrapper text (before / after the
-- structured payment-schedule output).
--
-- The customer-facing payment_terms now reads as:
--   [payment_terms_before]
--   [scheduleToString(payment_schedule)]
--   [payment_terms_after]
--
-- Each piece is independently editable on the quote detail page.
-- Both wrapper fields default to NULL (no prefix / no suffix); the
-- existing "Default <type> Terms" checkbox restores
-- `before + schedule + after` into the Terms textarea when checked.
-- =====================================================================

ALTER TABLE quotes ADD COLUMN payment_terms_before TEXT;
ALTER TABLE quotes ADD COLUMN payment_terms_after  TEXT;
