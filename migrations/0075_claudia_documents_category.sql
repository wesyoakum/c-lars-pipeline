-- =====================================================================
-- Migration 0075 — Claudia document category column.
--
-- Adds a single nullable `category` TEXT column to claudia_documents so
-- Claudia (or Wes) can label what a dropped file IS — RFQ, spec sheet,
-- contact list, meeting note, badge photo, etc. The column is optional
-- everywhere it appears; pre-existing rows stay NULL until categorized.
--
-- The settings page at /settings/claudia exposes a `set_document_category`
-- write tool. It ships default-DISABLED — Wes flips it on when he wants
-- Claudia to start writing categories during chat. The eventual
-- auto-categorize-on-upload pass is a separate feature; this migration
-- just makes the column available.
--
-- Reversible: dropping the column loses any categories Wes wrote, but
-- nothing else depends on it.
-- =====================================================================

ALTER TABLE claudia_documents ADD COLUMN category TEXT;
