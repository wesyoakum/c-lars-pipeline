// functions/ai-inbox/[id]/attachments/add.js
//
// POST /ai-inbox/:id/attachments/add
//
// Adds a new attachment to an existing entry. Body is multipart/form-data
// to support file uploads and text-paste in the same endpoint:
//
//   kind        'audio' | 'text' | 'document' | 'email' | 'image'
//   file        (multipart) — required for audio/document/email/image
//   text        (multipart) — required for kind='text'
//   reextract   '1' to trigger pipeline re-extraction after add (default: '1')
//
// On success: returns { ok: true, attachment, reextracted: bool }.
// The attachment row is created with status='pending'; if reextract=1
// we synchronously process the new attachment and re-run extraction.

import { one, run, stmt, batch } from '../../../lib/db.js';
import { uuid, now } from '../../../lib/ids.js';
import { uploadToR2 } from '../../../lib/r2.js';
import { processItem } from '../../process-helpers.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

const MAX_FILE_BYTES = 25 * 1024 * 1024; // OpenAI Whisper limit; reasonable cap for everything else too
const MAX_TEXT_LEN = 50000;              // 50K chars of pasted text — plenty for an email body

const ALLOWED_KINDS = new Set(['audio', 'text', 'document', 'email', 'image']);

const AUDIO_EXTS = new Set(['m4a', 'mp3', 'wav', 'webm', 'mp4', 'mpeg', 'mpga', 'ogg', 'flac']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'heic', 'heif', 'webp', 'bmp', 'tiff']);
const EMAIL_EXTS = new Set(['eml', 'msg']);
const DOCUMENT_EXTS = new Set([
  'pdf', 'docx', 'doc', 'rtf', 'odt', 'txt', 'md', 'csv', 'tsv', 'log',
  'json', 'xml', 'html', 'ppt', 'pptx', 'xls', 'xlsx',
]);

function inferKind(file) {
  const mime = (file.type || '').toLowerCase();
  const filename = (file.name || '').toLowerCase();
  const ext = (filename.split('.').pop() || '').toLowerCase();

  if (mime.startsWith('audio/') || mime === 'video/mp4' || AUDIO_EXTS.has(ext)) return 'audio';
  if (mime.startsWith('image/') || IMAGE_EXTS.has(ext)) return 'image';
  if (mime === 'message/rfc822' || EMAIL_EXTS.has(ext)) return 'email';
  if (mime.startsWith('application/') || mime === 'text/plain' || mime === 'text/csv'
      || mime === 'text/markdown' || DOCUMENT_EXTS.has(ext)) return 'document';
  return 'document';
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;

  // Verify ownership of the entry.
  const entry = await one(
    env.DB,
    'SELECT id FROM ai_inbox_items WHERE id = ? AND user_id = ?',
    [params.id, user.id]
  );
  if (!entry) return json({ ok: false, error: 'not_found' }, 404);

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return json({ ok: false, error: 'invalid_form_data' }, 400);
  }

  // Allow callers to explicitly request a kind, OR pass kind='auto' (or
  // omit kind entirely) and let the server infer from the file's MIME /
  // extension. The persistent drop zone uses 'auto' so dragging in any
  // file type Just Works.
  let kind = String(formData.get('kind') || '').trim();
  if (kind === 'auto' || kind === '') {
    const file = formData.get('file');
    if (!file || typeof file === 'string') {
      return json({ ok: false, error: 'file_required_for_auto_kind' }, 400);
    }
    kind = inferKind(file);
  }
  if (!ALLOWED_KINDS.has(kind)) {
    return json({ ok: false, error: 'bad_kind' }, 400);
  }

  const reextract = String(formData.get('reextract') || '1') !== '0';

  // Decide where the captured_text comes from based on kind.
  let r2Key = null;
  let mimeType = null;
  let sizeBytes = null;
  let filename = null;
  let capturedText = null;
  let capturedTextModel = null;
  let initialStatus = 'pending';

  if (kind === 'text') {
    const text = String(formData.get('text') || '').trim();
    if (!text) return json({ ok: false, error: 'text_required' }, 400);
    if (text.length > MAX_TEXT_LEN) {
      return json({ ok: false, error: 'text_too_long', max: MAX_TEXT_LEN }, 400);
    }
    capturedText = text;
    capturedTextModel = 'inline';
    initialStatus = 'ready';        // text needs no processing
    sizeBytes = text.length;
    filename = (formData.get('filename') || 'note.txt').toString().trim();
  } else {
    // File-based kinds — store in R2 first.
    const file = formData.get('file');
    if (!file || typeof file === 'string' || file.size === 0) {
      return json({ ok: false, error: 'file_required' }, 400);
    }
    if (file.size > MAX_FILE_BYTES) {
      return json({ ok: false, error: 'file_too_large', max: MAX_FILE_BYTES }, 400);
    }
    filename = file.name || `attachment.${kind}`;
    mimeType = file.type || null;
    sizeBytes = file.size;
    const ext = (filename.split('.').pop() || '').toLowerCase();
    r2Key = `ai-inbox/${params.id}/${uuid()}.${ext || 'bin'}`;
    try {
      await uploadToR2(env.DOCS, r2Key, file, {
        entryId: params.id,
        kind,
        uploadedBy: user.email,
      });
    } catch (e) {
      return json({ ok: false, error: 'upload_failed', detail: String(e.message || e) }, 500);
    }
  }

  // Optional question-context: when the user clicks "↳ Answer" on
  // an open question, the client passes the question text here so we
  // record what the attachment is answering. Stored on the attachment
  // row and used by compileContext() to label the section header in
  // the next extraction's user message.
  const answersQuestion = String(formData.get('answers_question') || '').trim().slice(0, 500) || null;

  // Compute next sort_order — append to the end.
  const maxSort = await one(
    env.DB,
    'SELECT COALESCE(MAX(sort_order), -1) AS max_sort FROM ai_inbox_attachments WHERE entry_id = ?',
    [params.id]
  );
  const sortOrder = (maxSort?.max_sort ?? -1) + 1;

  const attachmentId = uuid();
  const ts = now();
  await run(env.DB,
    `INSERT INTO ai_inbox_attachments
       (id, entry_id, kind, sort_order, is_primary, include_in_context,
        r2_key, mime_type, size_bytes, filename,
        captured_text, captured_text_model, status, answers_question, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [attachmentId, params.id, kind, sortOrder,
     r2Key, mimeType, sizeBytes, filename,
     capturedText, capturedTextModel, initialStatus, answersQuestion, ts, ts]);

  // Optionally re-process the entry so the newly-added attachment's
  // captured_text feeds the next extraction round. fromStep='attachments'
  // because we want the new attachment processed (and only the new one
  // — already-ready attachments are skipped by the pipeline).
  let reextracted = false;
  if (reextract) {
    try {
      await processItem(env, params.id, 'attachments');
      reextracted = true;
    } catch (e) {
      // processItem already wrote 'error' on the entry if extraction
      // failed; the attachment add itself succeeded, so we still return
      // ok=true and let the user see the error on the detail page.
      console.warn('[ai-inbox] reextract after attachment add failed:', e?.message || e);
    }
  }

  // Read back the attachment row (so the client gets the final status
  // post-processing) and return.
  const attachment = await one(env.DB,
    `SELECT id, kind, sort_order, is_primary, include_in_context,
            r2_key, mime_type, size_bytes, filename,
            captured_text, captured_text_model, status, error_message,
            answers_question, created_at
       FROM ai_inbox_attachments WHERE id = ?`,
    [attachmentId]);

  return json({ ok: true, attachment, reextracted });
}
