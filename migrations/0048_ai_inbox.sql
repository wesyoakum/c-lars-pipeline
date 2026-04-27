-- =====================================================================
-- Migration 0048: AI Inbox (voice-driven personal assistant — Phase 1).
--
-- Reversible experiment. The whole feature lives behind /ai-inbox and
-- is intentionally isolated from accounts/opportunities/contacts — no
-- cross-table foreign keys, no shared indexes, no triggers. If the
-- experiment is killed, a follow-up migration just drops the table and
-- the feature is gone with no schema fallout.
--
-- Pipeline per item:
--   audio upload  -> transcribe (OpenAI) -> classify -> extract -> ready
-- Each step writes status so partial failures are recoverable from the
-- last known good step. raw_transcript is permanent; extracted_json is
-- editable in the UI.
-- =====================================================================

CREATE TABLE IF NOT EXISTS ai_inbox_items (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,

  -- pending | transcribing | classifying | extracting | ready | error
  status              TEXT NOT NULL,
  error_message       TEXT,

  -- Capture metadata. source is 'audio_upload' for Phase 1; reserved
  -- for 'browser_record' / 'paste' in later phases.
  source              TEXT NOT NULL DEFAULT 'audio_upload',
  user_context        TEXT,                       -- short note from the upload form

  -- R2 audio file (stored in the existing DOCS bucket under the
  -- 'ai-inbox/' key prefix so the whole feature can be wiped by
  -- prefix-deleting that one folder).
  audio_r2_key        TEXT,
  audio_mime_type     TEXT,
  audio_size_bytes    INTEGER,
  audio_filename      TEXT,                       -- original filename for display

  -- AI artifacts.
  transcription_model TEXT,                       -- whisper-1 | gpt-4o-transcribe | gpt-4o-mini-transcribe
  raw_transcript      TEXT,
  context_type        TEXT,                       -- quick_note | meeting | trade_show | personal_note | other
  extracted_json      TEXT                        -- JSON blob; user-editable
);

-- Newest-first list per user.
CREATE INDEX IF NOT EXISTS idx_ai_inbox_user_created
  ON ai_inbox_items(user_id, created_at DESC);
