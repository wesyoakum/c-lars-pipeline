-- Extend items_library for the auto-populated quote line catalog.
-- The table was created in 0008 but never populated. Add fields
-- needed for part tracking, usage stats, and item notes.

ALTER TABLE items_library ADD COLUMN part_number TEXT;
ALTER TABLE items_library ADD COLUMN item_type TEXT DEFAULT 'product';
ALTER TABLE items_library ADD COLUMN default_cost REAL;
ALTER TABLE items_library ADD COLUMN use_count INTEGER DEFAULT 1;
ALTER TABLE items_library ADD COLUMN last_used_at TEXT;
ALTER TABLE items_library ADD COLUMN item_notes TEXT;

CREATE INDEX IF NOT EXISTS idx_items_library_part ON items_library(part_number);
CREATE INDEX IF NOT EXISTS idx_items_library_type ON items_library(item_type);
