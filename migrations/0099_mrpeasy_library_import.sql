-- 0099: MRPeasy library import — add source column + MRPeasy-specific fields
--
-- All 35 CSV columns are preserved. Quote-relevant fields map to dedicated
-- columns; everything else lives in mrp_raw_json for future use.

ALTER TABLE items_library ADD COLUMN source TEXT DEFAULT 'manual';

ALTER TABLE items_library ADD COLUMN mrp_group_number TEXT;
ALTER TABLE items_library ADD COLUMN mrp_group_name TEXT;
ALTER TABLE items_library ADD COLUMN mrp_in_stock REAL;
ALTER TABLE items_library ADD COLUMN mrp_available REAL;
ALTER TABLE items_library ADD COLUMN mrp_booked REAL;
ALTER TABLE items_library ADD COLUMN mrp_reorder_point REAL;
ALTER TABLE items_library ADD COLUMN mrp_lead_time INTEGER;
ALTER TABLE items_library ADD COLUMN mrp_vendor_number TEXT;
ALTER TABLE items_library ADD COLUMN mrp_vendor_name TEXT;
ALTER TABLE items_library ADD COLUMN mrp_vendor_part_number TEXT;
ALTER TABLE items_library ADD COLUMN mrp_storage_location TEXT;
ALTER TABLE items_library ADD COLUMN mrp_weight REAL;
ALTER TABLE items_library ADD COLUMN mrp_weight_unit TEXT;
ALTER TABLE items_library ADD COLUMN mrp_is_procured INTEGER;
ALTER TABLE items_library ADD COLUMN mrp_is_inventory INTEGER;
ALTER TABLE items_library ADD COLUMN mrp_revision TEXT;
ALTER TABLE items_library ADD COLUMN mrp_raw_json TEXT;

CREATE INDEX IF NOT EXISTS idx_items_library_source ON items_library(source);
