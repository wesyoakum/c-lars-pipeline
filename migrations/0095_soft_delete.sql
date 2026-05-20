-- Soft delete support: add deleted_at column to all deletable entities.
-- When set, the row is hidden from all queries but preserved for undo.
-- NULL = active row. ISO-8601 timestamp = soft-deleted.

-- Tier 1: high-value entities
ALTER TABLE accounts ADD COLUMN deleted_at TEXT;
ALTER TABLE opportunities ADD COLUMN deleted_at TEXT;
ALTER TABLE jobs ADD COLUMN deleted_at TEXT;
ALTER TABLE quotes ADD COLUMN deleted_at TEXT;
ALTER TABLE quote_lines ADD COLUMN deleted_at TEXT;
ALTER TABLE activities ADD COLUMN deleted_at TEXT;
ALTER TABLE contacts ADD COLUMN deleted_at TEXT;
ALTER TABLE cost_builds ADD COLUMN deleted_at TEXT;
ALTER TABLE documents ADD COLUMN deleted_at TEXT;
ALTER TABLE resources ADD COLUMN deleted_at TEXT;

-- Tier 2: library + config entities
ALTER TABLE items_library ADD COLUMN deleted_at TEXT;
ALTER TABLE labor_items ADD COLUMN deleted_at TEXT;
ALTER TABLE dm_items ADD COLUMN deleted_at TEXT;
ALTER TABLE builds_library ADD COLUMN deleted_at TEXT;
ALTER TABLE change_orders ADD COLUMN deleted_at TEXT;
