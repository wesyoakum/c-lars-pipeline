-- =====================================================================
-- Migration 0046: Add jobs.ntp_revision.
--
-- Mirrors the existing jobs.oc_revision column. Lets the NTP page
-- expose a "Revise" action analogous to the quote/OC revise — bumps
-- the counter, clears ntp_issued_at, and the form unlocks for re-issue.
-- =====================================================================

ALTER TABLE jobs ADD COLUMN ntp_revision INTEGER NOT NULL DEFAULT 1;
