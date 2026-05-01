-- =====================================================================
-- Migration 0065 — quote_lines WFM support.
--
-- Adds external_source / external_id / wfm_payload columns to
-- quote_lines so the WFM importer can write line items pulled from
-- DetailedQuote (Costs[] + Tasks[]) into Pipeline.
--
-- Idempotency: re-imports DELETE existing WHERE external_source='wfm'
-- and re-INSERT, so WFM-sourced lines stay in sync but user-added
-- (non-wfm) lines are preserved.
-- =====================================================================

ALTER TABLE quote_lines ADD COLUMN external_source TEXT;
ALTER TABLE quote_lines ADD COLUMN external_id     TEXT;
ALTER TABLE quote_lines ADD COLUMN wfm_payload     TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_quote_lines_ext
  ON quote_lines(external_source, external_id) WHERE external_id IS NOT NULL;
