-- 0102: Add internal detail fields to quote_lines
--
-- dm_cost / other_cost        — two-way sync with the linked price build
-- supplier_id / supplier_name — Katana supplier reference
-- delivery_estimate           — per-line delivery/lead-time (free text)
-- delivery_show_in_notes      — toggle to append delivery to line_notes on doc
-- notes_internal              — internal-only notes (never on customer docs)

ALTER TABLE quote_lines ADD COLUMN dm_cost REAL;
ALTER TABLE quote_lines ADD COLUMN other_cost REAL;
ALTER TABLE quote_lines ADD COLUMN supplier_id TEXT;
ALTER TABLE quote_lines ADD COLUMN supplier_name TEXT;
ALTER TABLE quote_lines ADD COLUMN delivery_estimate TEXT;
ALTER TABLE quote_lines ADD COLUMN delivery_show_in_notes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quote_lines ADD COLUMN notes_internal TEXT;
