-- 0006_quote_line_cost_refs.sql
--
-- Add optional cost reference columns to quote_lines so each line can
-- link back to a specific DM or labor library item from the linked
-- cost build. This lets the UI show cost vs. selling price per line.
--
-- cost_ref_type: 'dm' | 'labor' | NULL
-- cost_ref_id:   dm_items.id or labor_items.id | NULL
-- cost_ref_amount: the cost at the time the reference was set (snapshot)

ALTER TABLE quote_lines ADD COLUMN cost_ref_type   TEXT;
ALTER TABLE quote_lines ADD COLUMN cost_ref_id     TEXT;
ALTER TABLE quote_lines ADD COLUMN cost_ref_amount REAL;
