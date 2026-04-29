-- 0058_opportunity_notes_internal.sql
--
-- AI Inbox v3 follow-up: tech specs / requirements extracted from an
-- entry get pushed to the "internal notes" of a linked opportunity
-- or quote. Quotes already carry notes_internal (since 0001 — the
-- yellow box in the quote-detail UI). Opportunities did not — they
-- only had a single `description` field, which is treated as
-- customer-facing in some downstream surfaces.
--
-- Add a sibling `notes_internal` column on opportunities so the AI
-- Inbox apply-requirements flow has a non-public destination, and
-- so the opportunity detail page can grow a matching internal-notes
-- panel later (parity with quotes).

ALTER TABLE opportunities ADD COLUMN notes_internal TEXT;
