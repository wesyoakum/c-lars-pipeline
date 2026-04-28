// functions/ai-inbox/new.js
//
// POST /ai-inbox/new
//
// Multipart upload handler. Accepts an audio file + optional user_context,
// validates size/type, stores the audio in R2 under `ai-inbox/<id>.<ext>`,
// inserts the row in 'pending', then immediately runs the processing
// pipeline (transcribe → classify → extract). Redirects to the detail
// page when done.

import { run, stmt, batch } from '../lib/db.js';
import { uuid, now } from '../lib/ids.js';
import { uploadToR2 } from '../lib/r2.js';
import { redirectWithFlash, redirect } from '../lib/http.js';
import { processItem } from './process-helpers.js';

const MAX_BYTES = 25 * 1024 * 1024; // OpenAI Whisper hard limit

const ACCEPTED_EXTS = new Set([
  'm4a', 'mp3', 'wav', 'webm', 'mp4', 'mpeg', 'mpga', 'ogg', 'flac',
]);

const ACCEPTED_MIMES_PREFIX = 'audio/';

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return redirectWithFlash('/ai-inbox', 'Invalid form data.', 'error');
  }

  const file = formData.get('audio');
  const userContext = (formData.get('user_context') || '').toString().trim() || null;

  if (!file || typeof file === 'string' || file.size === 0) {
    return redirectWithFlash('/ai-inbox', 'No audio file selected.', 'error');
  }

  if (file.size > MAX_BYTES) {
    return redirectWithFlash(
      '/ai-inbox',
      `File too large (${formatSize(file.size)}). Max is ${formatSize(MAX_BYTES)} (OpenAI Whisper limit).`,
      'error'
    );
  }

  const filename = file.name || 'audio';
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const mime = file.type || '';

  const validExt = ACCEPTED_EXTS.has(ext);
  const validMime = mime.startsWith(ACCEPTED_MIMES_PREFIX) || mime === 'video/mp4'; // .mp4 audio
  if (!validExt && !validMime) {
    return redirectWithFlash(
      '/ai-inbox',
      `Unsupported audio format (${escapeBrief(mime || ext)}). Try m4a, mp3, wav, webm, mp4, ogg, or flac.`,
      'error'
    );
  }

  const id = uuid();
  const ts = now();
  const r2Ext = ACCEPTED_EXTS.has(ext) ? ext : 'm4a';
  const r2Key = `ai-inbox/${id}.${r2Ext}`;

  try {
    await uploadToR2(env.DOCS, r2Key, file, {
      itemId: id,
      uploadedBy: user.email,
    });
  } catch (e) {
    return redirectWithFlash('/ai-inbox', `Upload failed: ${e.message || e}`, 'error');
  }

  // v3: insert the entry row + an audio attachment row in a single
  // batch. The audio_* columns on ai_inbox_items continue to be
  // populated for backward compatibility through the v3 transition;
  // the canonical source is now the attachment row.
  const attachmentId = uuid();
  await batch(env.DB, [
    stmt(env.DB,
      `INSERT INTO ai_inbox_items
         (id, user_id, created_at, updated_at, status, source, user_context,
          audio_r2_key, audio_mime_type, audio_size_bytes, audio_filename)
       VALUES (?, ?, ?, ?, 'pending', 'audio_upload', ?, ?, ?, ?, ?)`,
      [id, user.id, ts, ts, userContext,
       r2Key, mime || `audio/${r2Ext}`, file.size, filename]),
    stmt(env.DB,
      `INSERT INTO ai_inbox_attachments
         (id, entry_id, kind, sort_order, is_primary, include_in_context,
          r2_key, mime_type, size_bytes, filename,
          status, created_at, updated_at)
       VALUES (?, ?, 'audio', 0, 1, 1, ?, ?, ?, ?, 'pending', ?, ?)`,
      [attachmentId, id, r2Key, mime || `audio/${r2Ext}`, file.size, filename, ts, ts]),
  ]);

  // Run the pipeline synchronously. If it fails, the row's status is
  // set to 'error' inside processItem and the user lands on the detail
  // page where they can see the error message.
  try {
    await processItem(env, id);
  } catch (e) {
    // processItem already wrote 'error' status + message; just continue
    // to the detail page so the user can see what happened.
  }

  return redirect(`/ai-inbox/${id}`);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeBrief(s) {
  return String(s || '').replace(/[<>&"']/g, '').slice(0, 60);
}
