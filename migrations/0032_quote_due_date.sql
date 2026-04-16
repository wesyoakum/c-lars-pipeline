-- 0032_quote_due_date.sql
--
-- Add `quote_due_date` to the quotes table to preserve the due-date
-- field that WorkflowMax tracks separately from `valid_until`. In WFM's
-- export this is the "QuoteDueDate" column (populated on 192 / 343
-- quote rows). The existing `valid_until` column stores WFM's "Valid
-- Until" (populated on all 343 rows); the two are semantically
-- different (due = when we need to deliver the quote; valid_until =
-- when the customer-facing quote expires), so keep both.
--
-- Nullable, no default — UI can expose it alongside valid_until later.

ALTER TABLE quotes ADD COLUMN quote_due_date TEXT;
