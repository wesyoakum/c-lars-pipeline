-- 0061_documents_superseded.sql
--
-- When a document is regenerated (Generate PDF / Download Word on a
-- quote, OC, NTP, etc.) the new file used to be added as a sibling
-- of the old one — the docs list filled up with duplicates with the
-- same name. Now the regen flow marks the previous version with the
-- same (parent + filename) as superseded; superseded rows hide from
-- the default docs lists but stick around so the audit / restore
-- path is intact.
--
-- Two columns:
--   superseded_at     — when this row was hidden (NULL = visible)
--   superseded_by_id  — the new doc that replaced it (FK)

ALTER TABLE documents ADD COLUMN superseded_at TEXT;
ALTER TABLE documents ADD COLUMN superseded_by_id TEXT REFERENCES documents(id);

CREATE INDEX IF NOT EXISTS idx_documents_superseded_at
  ON documents(superseded_at)
  WHERE superseded_at IS NULL;
