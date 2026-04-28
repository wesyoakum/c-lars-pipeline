-- =====================================================================
-- Migration 0054: ai_inbox_attachments.answers_question
--
-- One nullable text column. When the user clicks "↳ Answer" on an
-- entry's open question and uploads/records/types an answer, the
-- resulting attachment row records which question it's answering. The
-- compileContext helper uses this to label the attachment's section in
-- the next extraction's user message:
--   === User text — answer to: "What is the timeline?" ===
--   ...the user's typed/recorded/uploaded answer...
--
-- so the LLM sees the explicit Q/A pairing on the next re-extraction
-- and can move that question out of `open_questions`.
-- =====================================================================

ALTER TABLE ai_inbox_attachments ADD COLUMN answers_question TEXT;
