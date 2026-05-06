-- =====================================================================
-- Migration 0081 — Structured email metadata + parent/child for
-- claudia_documents.
--
-- The drop-zone-as-inbox push: emails (.eml) are the dominant doc type
-- and we were stuffing Subject / From / Date inside the body of
-- full_text where the renderer couldn't show them and the user
-- couldn't sort/filter on them. This migration:
--
--   * Adds dedicated columns for the email headers we care about
--     (sender_email / sender_name / subject / email_date /
--     message_id) — populated on upload by emailMetadata() in
--     claudia-mime.js.
--
--   * Adds structured_data TEXT for forward-compat: a JSON blob keyed
--     by `kind` ("email", "attachment", later "rfq" / "quote" /
--     "business_card") so per-type extractors can stash structured
--     fields without growing the column count further.
--
--   * Adds parent_id (self-referential FK) so attachments inside an
--     EML can be ingested as their own rows linked back to the
--     parent email — matches the inbox mental model and lets Claudia
--     read attachments without re-parsing the parent.
--
-- Backfill: pre-existing rows stay NULL on the new columns. They'll
-- continue rendering as filename-only and age out / get trashed
-- naturally. No retroactive Haiku run (would re-fetch every R2 object
-- and burn tokens for old, mostly-stale rows).
-- =====================================================================

-- Email-specific structured fields, populated when content_type is
-- message/rfc822 or extension is .eml.
ALTER TABLE claudia_documents ADD COLUMN sender_email TEXT;
ALTER TABLE claudia_documents ADD COLUMN sender_name TEXT;
ALTER TABLE claudia_documents ADD COLUMN subject TEXT;
ALTER TABLE claudia_documents ADD COLUMN email_date TEXT;  -- ISO 8601 normalized
ALTER TABLE claudia_documents ADD COLUMN message_id TEXT;

-- Generic per-type structured payload (JSON). Today: { kind: 'email',
-- ...meta, attachments_count } for emails and { kind: 'attachment',
-- from_email: <parent_id> } for their attachments. Extractors for
-- other kinds can land later without another schema change.
ALTER TABLE claudia_documents ADD COLUMN structured_data TEXT;

-- Self-referential. Children orphan on parent delete; we soft-delete
-- via retention='trashed' anyway, so a cascade would be wrong.
ALTER TABLE claudia_documents ADD COLUMN parent_id TEXT
  REFERENCES claudia_documents(id);

-- Index for the full-page Inbox view's category filter (the most
-- common slice — "show me only RFQs from the last week").
CREATE INDEX IF NOT EXISTS idx_claudia_documents_user_category
  ON claudia_documents(user_id, category, created_at DESC);

-- Quick-search by subject prefix in the Inbox table.
CREATE INDEX IF NOT EXISTS idx_claudia_documents_user_subject
  ON claudia_documents(user_id, subject);

-- Used to find all attachments under a given parent email row.
CREATE INDEX IF NOT EXISTS idx_claudia_documents_parent
  ON claudia_documents(parent_id);
