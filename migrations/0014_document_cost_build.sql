-- 0014_document_cost_build.sql
--
-- Link documents to cost_builds (price builds) so vendor quotes,
-- spreadsheets, emails, etc. can be uploaded as reference on a
-- price build.

ALTER TABLE documents ADD COLUMN cost_build_id TEXT REFERENCES cost_builds(id);
CREATE INDEX IF NOT EXISTS idx_documents_cost_build ON documents(cost_build_id);
