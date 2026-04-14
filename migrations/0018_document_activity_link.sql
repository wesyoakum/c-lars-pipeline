-- 0018_document_activity_link.sql
--
-- Link documents to an activity row so note authors can attach images
-- (screenshots, photos) that render inline with the note body on the
-- opportunity overview. Notes remain rows in the activities table
-- (type='note'); the document just points back at the note it belongs to.

ALTER TABLE documents ADD COLUMN activity_id TEXT REFERENCES activities(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_documents_activity ON documents(activity_id);
