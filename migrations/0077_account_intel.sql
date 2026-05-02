-- =====================================================================
-- Migration 0077 — Per-account AI intel notes.
--
-- A separate notes field on accounts that Claudia maintains, distinct
-- from the existing human-edited `notes` column. The point is to give
-- her a structured place to keep "what I know about this customer"
-- — key people, decision dynamics, recent context, watch-outs — that
-- she can read back when ${display} asks about the account, and
-- update as new info comes in.
--
-- Markdown blob, rolling document (Claudia rewrites the whole thing
-- when it changes, not append-only). intel_updated_at lets the read
-- tool report freshness so Claudia can say "this is 3 days old, I'll
-- refresh from recent activity" if it's stale.
--
-- Reversible: dropping these columns just loses the intel data.
-- Nothing else depends on them.
-- =====================================================================

ALTER TABLE accounts ADD COLUMN intel_notes TEXT;
ALTER TABLE accounts ADD COLUMN intel_updated_at TEXT;
