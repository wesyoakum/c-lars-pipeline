-- =====================================================================
-- Migration 0052: AI Inbox v3 — split attachments off the entry row.
--
-- An "Entry" (still stored in ai_inbox_items, table name unchanged) can
-- now hold N attachments of mixed kinds (audio, text, document, email,
-- image). Each attachment caches its captured_text — the transcript for
-- audio, body for email, OCR output for image, etc. Extraction will run
-- over the compiled-context concatenation of all attachments where
-- include_in_context = 1.
--
-- The audio_* / raw_transcript / transcription_model columns on
-- ai_inbox_items are NOT dropped here. Phase B keeps writing both
-- locations through the transition; a follow-up migration will remove
-- the legacy columns once nothing reads them.
--
-- ai_inbox_links and ai_inbox_entity_matches are unchanged.
-- =====================================================================

CREATE TABLE IF NOT EXISTS ai_inbox_attachments (
  id                  TEXT PRIMARY KEY,
  entry_id            TEXT NOT NULL REFERENCES ai_inbox_items(id) ON DELETE CASCADE,

  -- 'audio' | 'text' | 'document' | 'email' | 'image'.
  kind                TEXT NOT NULL,

  -- 0-based ordering within the entry. Lower numbers appear first in
  -- the compiled context. Defaults to 0 so the first attachment ends
  -- up first; subsequent attachments will be sorted by kind-priority
  -- on insert by the route handler.
  sort_order          INTEGER NOT NULL DEFAULT 0,

  -- 0/1. Exactly one attachment per entry should have is_primary=1
  -- (the page list/icon/summary keys off this). Enforced in code, not
  -- via constraint, so the backfill works even for entries with no
  -- audio yet.
  is_primary          INTEGER NOT NULL DEFAULT 0,

  -- 0/1. Toggle controls whether this attachment's captured_text
  -- contributes to the compiled context fed to extraction. Defaults
  -- to 1.
  include_in_context  INTEGER NOT NULL DEFAULT 1,

  -- File metadata. NULL for kind='text' (no file — captured_text was
  -- typed/pasted at upload time).
  r2_key              TEXT,
  mime_type           TEXT,
  size_bytes          INTEGER,
  filename            TEXT,

  -- Cached extracted text — the per-attachment transcript / OCR /
  -- email body / file text. NULL when not yet processed; the status
  -- column drives the UI.
  captured_text       TEXT,
  captured_text_model TEXT,            -- e.g. 'gpt-4o-transcribe' | 'convertapi' | 'eml-parse' | 'inline'

  -- 'pending' | 'processing' | 'ready' | 'error'. Per-attachment
  -- status so a single failed PDF doesn't block the rest of the entry.
  status              TEXT NOT NULL,
  error_message       TEXT,

  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_inbox_attachments_entry
  ON ai_inbox_attachments(entry_id, sort_order);

-- Backfill: each existing entry that has an audio file becomes one
-- attachment row. lower(hex(randomblob(16))) gives a 32-char unique
-- hex id — functionally equivalent to a UUID for FK purposes.
INSERT INTO ai_inbox_attachments (
  id, entry_id, kind, sort_order, is_primary, include_in_context,
  r2_key, mime_type, size_bytes, filename,
  captured_text, captured_text_model, status, created_at, updated_at
)
SELECT
  lower(hex(randomblob(16))),
  id, 'audio', 0, 1, 1,
  audio_r2_key, audio_mime_type, audio_size_bytes, audio_filename,
  raw_transcript, transcription_model,
  CASE WHEN raw_transcript IS NOT NULL AND raw_transcript != ''
       THEN 'ready'
       ELSE 'pending' END,
  created_at, updated_at
FROM ai_inbox_items
WHERE audio_r2_key IS NOT NULL;
