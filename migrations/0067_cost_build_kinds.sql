-- =====================================================================
-- Migration 0067 — cost_build kinds.
--
-- Adds a build_kind column to cost_builds so the price-builder UI can
-- render different field sets per quote type:
--   eps_full        — current behavior: DM/DL/IMOH/Other + library toggles
--   spares_simple   — Material cost (dm_user_cost) + Other (default 0).
--                     DL and IMOH hidden, treated as 0.
--   service_*       — TBD; placeholder for future service-quote variants
--   wfm_reference   — imported from WFM. Editable, but UI shows the
--                     "WFM imported" provenance and may collapse the
--                     full cost decomposition.
--
-- Existing rows backfilled to 'eps_full' so the current UI keeps
-- working unchanged. New builds get their kind chosen at creation time
-- based on the parent quote's quote_type (or forced to 'wfm_reference'
-- when created by the WFM importer).
-- =====================================================================

ALTER TABLE cost_builds ADD COLUMN build_kind TEXT NOT NULL DEFAULT 'eps_full';
CREATE INDEX IF NOT EXISTS idx_cost_builds_kind ON cost_builds(build_kind);
