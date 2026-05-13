-- 0086_quote_lines_active_and_parent.sql
--
-- Two soft-status / structural additions to quote_lines:
--
--  1. `is_active` — Active / Inactive toggle. Inactive lines stay in the
--     DB so the user can reactivate them, but are excluded from quote
--     totals and from rendered PDF / DOCX output. Mirrors the
--     accounts.is_active pattern from migration 0030.
--
--  2. `parent_line_id` — single-level grouping. A "parent" line carries
--     just a title + line_notes; its children are normal lines that
--     contribute their extended_price to quote totals as usual but
--     render under the parent's header on the PDF (the parent shows the
--     summed total, children are not printed individually). NULL means
--     the line is top-level.
--
-- New rows default to Active and top-level (no parent). Existing rows
-- are backfilled to the same defaults via the NOT NULL DEFAULT 1 /
-- nullable column.

ALTER TABLE quote_lines ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE quote_lines ADD COLUMN parent_line_id TEXT REFERENCES quote_lines(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_quote_lines_is_active ON quote_lines(is_active);
CREATE INDEX IF NOT EXISTS idx_quote_lines_parent ON quote_lines(parent_line_id);
