-- 0015_resources.sql
--
-- General-purpose resources table for company reference documents:
-- NDAs, governing documents, checklists, reference guides, etc.
-- These are NOT tied to a specific opportunity/quote/job.

CREATE TABLE IF NOT EXISTS resources (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  category            TEXT NOT NULL DEFAULT 'other',
  original_filename   TEXT,
  r2_key              TEXT NOT NULL UNIQUE,
  mime_type           TEXT,
  size_bytes          INTEGER,
  notes               TEXT,
  uploaded_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  uploaded_by_user_id TEXT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_resources_category ON resources(category);
