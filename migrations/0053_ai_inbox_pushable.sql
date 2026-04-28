-- =====================================================================
-- Migration 0053: schema additions for AI Inbox push-to-CRM features.
--
-- Three small additive changes:
--   1. activities.contact_id  — let a task/note/call activity be
--                               attached directly to a contact, in
--                               addition to (or instead of) the
--                               existing opportunity_id / account_id /
--                               quote_id / job_id pointers. Lets us
--                               "push transcript-as-note to Chad
--                               Brown" with the resulting activity
--                               showing up cleanly on Chad's contact
--                               page rather than just on the parent
--                               account's timeline.
--   2. documents.contact_id   — same idea on the documents side, so a
--                               file attachment from an entry can land
--                               at contact-level scope.
--   3. accounts.email         — accounts already have phone + website
--                               but no email. Add it so we can push
--                               an extracted email address from an
--                               entry directly onto the account.
--
-- All three additions are nullable + back-compat. Existing rows are
-- unaffected; existing queries that don't read these columns keep
-- working unchanged.
-- =====================================================================

ALTER TABLE activities ADD COLUMN contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE;
ALTER TABLE documents  ADD COLUMN contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE;
ALTER TABLE accounts   ADD COLUMN email      TEXT;

CREATE INDEX IF NOT EXISTS idx_activities_contact ON activities(contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_contact  ON documents(contact_id)  WHERE contact_id IS NOT NULL;
