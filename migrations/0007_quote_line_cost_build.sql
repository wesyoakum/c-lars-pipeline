-- 0007_quote_line_cost_build.sql
--
-- Add cost_build_id to quote_lines so each line can link to a cost
-- build. The line's price is derived from the cost build's computed
-- quote price. Replaces the per-item cost_ref columns from 0006
-- (which are left in place but unused).

ALTER TABLE quote_lines ADD COLUMN cost_build_id TEXT REFERENCES cost_builds(id);
