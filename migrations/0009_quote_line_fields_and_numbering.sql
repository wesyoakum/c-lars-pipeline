-- Migration 0009: Add fields for line items (title/part_number, line_notes)
-- and price build numbering (cost_builds.number). Also add columns for
-- quote numbering overhaul (quote_seq on quotes table) and line item
-- "option" flag. Add payment_terms_options and delivery_terms_options tables.

-- Line items: title/part number and separate notes field
ALTER TABLE quote_lines ADD COLUMN title TEXT;
ALTER TABLE quote_lines ADD COLUMN part_number TEXT;
ALTER TABLE quote_lines ADD COLUMN line_notes TEXT;
ALTER TABLE quote_lines ADD COLUMN is_option INTEGER NOT NULL DEFAULT 0;

-- Price build numbering (P1.1, P1.2, etc.)
ALTER TABLE cost_builds ADD COLUMN number TEXT;

-- Quote numbering: store the sequence number within the opportunity
-- so we can generate Q25012-1, Q25012-2, etc.
ALTER TABLE quotes ADD COLUMN quote_seq INTEGER;

-- Payment terms options (editable defaults)
CREATE TABLE IF NOT EXISTS payment_terms_options (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed some default payment terms
INSERT INTO payment_terms_options (id, label, sort_order) VALUES
  ('pt-net30', 'Net 30', 1),
  ('pt-net60', 'Net 60', 2),
  ('pt-net90', 'Net 90', 3),
  ('pt-50down', '50% down, 50% on delivery', 4),
  ('pt-cod', 'COD (Cash on Delivery)', 5),
  ('pt-cia', 'CIA (Cash in Advance)', 6),
  ('pt-progress', 'Progress payments per milestone', 7);

-- Delivery/incoterms options (merged incoterms + delivery terms)
CREATE TABLE IF NOT EXISTS delivery_terms_options (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed default delivery/incoterms
INSERT INTO delivery_terms_options (id, label, sort_order) VALUES
  ('dt-exw', 'EXW — Ex Works', 1),
  ('dt-fca', 'FCA — Free Carrier', 2),
  ('dt-fob', 'FOB — Free on Board', 3),
  ('dt-cif', 'CIF — Cost, Insurance & Freight', 4),
  ('dt-dap', 'DAP — Delivered at Place', 5),
  ('dt-ddp', 'DDP — Delivered Duty Paid', 6),
  ('dt-pickup', 'Customer Pickup', 7);
