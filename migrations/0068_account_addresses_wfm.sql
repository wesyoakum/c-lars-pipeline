-- =====================================================================
-- Migration 0068 — wfm idempotency on account_addresses.
--
-- The WFM importer writes addresses into the normalized
-- account_addresses table so the account-detail UI actually surfaces
-- them. Need external_source + external_id so re-imports are
-- idempotent (DELETE wfm-sourced rows, then re-INSERT) without
-- touching user-added addresses.
-- =====================================================================

ALTER TABLE account_addresses ADD COLUMN external_source TEXT;
ALTER TABLE account_addresses ADD COLUMN external_id     TEXT;
CREATE INDEX IF NOT EXISTS idx_account_addresses_ext
  ON account_addresses(external_source, external_id)
  WHERE external_id IS NOT NULL;
