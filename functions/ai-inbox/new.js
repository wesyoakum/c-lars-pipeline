// functions/ai-inbox/new.js
//
// POST /ai-inbox/new
//
// Multipart upload handler. Accepts any single file (audio, document,
// email, image) and an optional user_context note, infers the kind
// from MIME / extension, stores the file in R2, creates a new entry
// + first attachment, and synchronously runs the pipeline.
//
// v3 generalization: previously hardcoded to audio uploads; now
// dispatches to whichever attachment processor matches the file kind.
// For backward compat, audio uploads still also populate the legacy
// audio_* columns on ai_inbox_items.

import { run, stmt, batch } from '../lib/db.js';
import { uuid, now } from '../lib/ids.js';
import { uploadToR2 } from '../lib/r2.js';
import { redirectWithFlash, redirect } from '../lib/http.js';
import { processItem } from './process-helpers.js';

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;     // OpenAI Whisper hard limit
const MAX_OTHER_BYTES = 50 * 1024 * 1024;     // sane cap for non-audio uploads

const AUDIO_EXTS = new Set(['m4a', 'mp3', 'wav', 'webm', 'mp4', 'mpeg', 'mpga', 'ogg', 'flac']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'heic', 'heif', 'webp', 'bmp', 'tiff']);
const EMAIL_EXTS = new Set(['eml', 'msg']);
const DOCUMENT_EXTS = new Set([
  'pdf', 'docx', 'doc', 'rtf', 'odt', 'txt', 'md', 'csv', 'tsv', 'log',
  'json', 'xml', 'html', 'ppt', 'pptx', 'xls', 'xlsx',
]);

/**
 * Infer attachment kind from a File. Looks at MIME first, falls back
 * to extension, defaults to 'document' for unknown types so the file
 * is still stored.
 */
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
  const { env, data, request } = context;
  const user = data?.user;

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return redirectWithFlash('/ai-inbox', 'Invalid form data.', 'error');
  }

  // Accept either 'file' (the new generic name) or 'audio' (the legacy
  // name kept so the existing inbox upload form still works).
  const file = formData.get('file') || formData.get('audio');
  const userContext = (formData.get('user_context') || '').toString().trim() || null;

  if (!file || typeof file === 'string' || file.size === 0) {
    return redirectWithFlash('/ai-inbox', 'No file selected.', 'error');
  }

  const kind = inferKind(file);
  const cap = kind === 'audio' ? MAX_AUDIO_BYTES : MAX_OTHER_BYTES;
  if (file.size > cap) {
    return redirectWithFlash(
      '/ai-inbox',
      `File too large (${formatSize(file.size)}). Max for ${kind} is ${formatSize(cap)}.`,
      'error'
    );
  }

  const filename = file.name || `attachment.${kind}`;
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const mime = file.type || '';
  const entryId = uuid();
  const ts = now();
  const r2Key = `ai-inbox/${entryId}/${uuid()}.${ext || 'bin'}`;

  try {
    await uploadToR2(env.DOCS, r2Key, file, {
      entryId,
      kind,
      uploadedBy: user.email,
    });
  } catch (e) {
    return redirectWithFlash('/ai-inbox', `Upload failed: ${e.message || e}`, 'error');
  }

  // For audio, also populate the legacy audio_* columns on the entry
  // so the v1/v2 read paths (and the audio player on the detail page)
  // keep working through the v3 transition. For other kinds, leave
  // them null — only the attachment row matters going forward.
  const isAudio = kind === 'audio';
  const attachmentId = uuid();
  await batch(env.DB, [
    stmt(env.DB,
      `INSERT INTO ai_inbox_items
         (id, user_id, created_at, updated_at, status, source, user_context,
          audio_r2_key, audio_mime_type, audio_size_bytes, audio_filename)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      [entryId, user.id, ts, ts,
       isAudio ? 'audio_upload' : 'file_upload',
       userContext,
       isAudio ? r2Key : null,
       isAudio ? (mime || `audio/${ext || 'm4a'}`) : null,
       isAudio ? file.size : null,
       isAudio ? filename : null]),
    stmt(env.DB,
      `INSERT INTO ai_inbox_attachments
         (id, entry_id, kind, sort_order, is_primary, include_in_context,
          r2_key, mime_type, size_bytes, filename,
          status, created_at, updated_at)
       VALUES (?, ?, ?, 0, 1, 1, ?, ?, ?, ?, 'pending', ?, ?)`,
      [attachmentId, entryId, kind, r2Key, mime || null, file.size, filename, ts, ts]),
  ]);

  // Run the pipeline synchronously. If it fails, the entry's status is
  // set to 'error' inside processItem and the user lands on the detail
  // page where they can see the error message.
  try {
    await processItem(env, entryId);
  } catch (e) {
    // processItem already wrote 'error' status + message; just continue
    // to the detail page so the user can see what happened.
  }

  return redirect(`/ai-inbox/${entryId}`);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
