-- 0011_quote_status_overhaul.sql
--
-- Overhaul quote statuses and add customer_po_number to opportunities.
--
-- New quote statuses: draft, issued, revision_draft, revision_issued,
--                     accepted, rejected, expired, dead
-- Removed: internal_review, approved_internal, submitted, superseded
--
-- Also adds customer_po_number text field to opportunities for the
-- closed_won gate check.

-- Add customer PO number field to opportunities
ALTER TABLE opportunities ADD COLUMN customer_po_number TEXT;

-- Migrate existing quote statuses to new scheme
UPDATE quotes SET status = 'issued' WHERE status = 'submitted';
UPDATE quotes SET status = 'issued' WHERE status = 'approved_internal';
UPDATE quotes SET status = 'draft' WHERE status = 'internal_review';
UPDATE quotes SET status = 'dead' WHERE status = 'superseded';
