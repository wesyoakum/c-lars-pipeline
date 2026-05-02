-- =====================================================================
-- Migration 0071 — Claudia documents (drop-zone storage).
--
-- Wes drops files (PDF / DOCX / TXT / MD) into the Sandbox-Assistant
-- chat; this table holds the metadata + extracted plain text for each.
-- Originals live in R2 under claudia-docs/<user_id>/<doc_id>/<filename>.
-- The extracted text lives inline in `full_text` for fast LIKE-search +
-- direct return from the read_document tool.
--
-- Retention is global (documents persist across conversations) with
-- three offramps:
--   * 'auto'         — default; eligible for Claudia-recommended cleanup.
--   * 'keep_forever' — manual flag from the user; Claudia must not
--                       suggest trashing these.
--   * 'trashed'      — soft-deleted; hidden from search/read; kept on
--                       the row for audit and possible undelete.
--
-- Reversible: dropping the table + the matching R2 prefix removes the
-- whole feature.
-- =====================================================================

CREATE TABLE IF NOT EXISTS claudia_documents (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  filename          TEXT NOT NULL,
  content_type      TEXT,                       -- e.g. 'application/pdf', 'text/plain'
  size_bytes        INTEGER,
  r2_key            TEXT NOT NULL,              -- key inside the DOCS bucket
  full_text         TEXT,                       -- extracted text content
  summary           TEXT,                       -- short summary for the doc list (optional)
  retention         TEXT NOT NULL DEFAULT 'auto'
                       CHECK (retention IN ('auto','keep_forever','trashed')),
  extraction_status TEXT NOT NULL DEFAULT 'ready'
                       CHECK (extraction_status IN ('ready','partial','error')),
  extraction_error  TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  last_accessed_at  TEXT,                       -- bumped when read_document() returns it
  trashed_at        TEXT                        -- set when retention flips to 'trashed'
);

CREATE INDEX IF NOT EXISTS idx_claudia_documents_user_active
  ON claudia_documents(user_id, created_at DESC)
  WHERE retention != 'trashed';

CREATE INDEX IF NOT EXISTS idx_claudia_documents_retention
  ON claudia_documents(user_id, retention);
