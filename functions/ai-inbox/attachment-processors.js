// functions/ai-inbox/attachment-processors.js
//
// Per-kind processors that turn an attachment into captured_text.
// Each function:
//   - takes (env, attachment row)
//   - sets status='processing' before doing work
//   - on success: stores the captured_text + captured_text_model and
//     sets status='ready'
//   - on failure: stores error_message and sets status='error', then
//     throws so the caller can decide whether to surface or silence
//
// Phase B ships with audio + text processors only. document/email/image
// stubs return placeholder text so the pipeline doesn't break when the
// frontend lets users add those kinds; full processors arrive in Phase D.

import { run } from '../lib/db.js';
import { now } from '../lib/ids.js';
import { transcribe } from './prompts.js';

/**
 * Dispatcher. Picks the right processor for the attachment's kind and
 * runs it. Exported for use by processItem() and the manual re-run
 * endpoint per attachment.
 */
export async function processAttachment(env, attachment) {
  switch (attachment.kind) {
    case 'audio':       return processAudio(env, attachment);
    case 'text':        return processText(env, attachment);
    case 'document':    return processDocument(env, attachment);
    case 'email':       return processEmailStub(env, attachment);
    case 'image':       return processImageStub(env, attachment);
    default:
      await markError(env.DB, attachment.id, `Unknown attachment kind: ${attachment.kind}`);
      throw new Error(`Unknown attachment kind: ${attachment.kind}`);
  }
}

// ---------------------------------------------------------------------
// Per-kind processors
// ---------------------------------------------------------------------

async function processAudio(env, attachment) {
  if (!attachment.r2_key) {
    await markError(env.DB, attachment.id, 'Audio attachment has no r2_key.');
    throw new Error('Audio attachment has no r2_key.');
  }
  await markProcessing(env.DB, attachment.id);
  try {
    const audioObj = await env.DOCS.get(attachment.r2_key);
    if (!audioObj) throw new Error('Audio file missing in R2.');
    const audioBuffer = await audioObj.arrayBuffer();
    const blob = new Blob([audioBuffer], { type: attachment.mime_type || 'audio/m4a' });
    const named = new File([blob], attachment.filename || `audio.${guessExt(attachment.mime_type)}`, {
      type: attachment.mime_type || 'audio/m4a',
    });
    const result = await transcribe(env, named);
    await markReady(env.DB, attachment.id, result.text || '', result.model || null);
    return result.text || '';
  } catch (e) {
    await markError(env.DB, attachment.id, `Transcription failed: ${e.message || e}`);
    throw e;
  }
}

async function processText(env, attachment) {
  // Text attachments: captured_text was set at upload time. Just flip
  // status to ready (idempotent). No external work to do.
  if (!attachment.captured_text) {
    await markError(env.DB, attachment.id, 'Text attachment has no captured_text.');
    throw new Error('Text attachment has no captured_text.');
  }
  await markReady(env.DB, attachment.id, attachment.captured_text, 'inline');
  return attachment.captured_text;
}

async function processDocument(env, attachment) {
  if (!attachment.r2_key) {
    await markError(env.DB, attachment.id, 'Document attachment has no r2_key.');
    throw new Error('Document attachment has no r2_key.');
  }

  const filename = attachment.filename || 'document';
  const ext = (filename.split('.').pop() || '').toLowerCase();

  await markProcessing(env.DB, attachment.id);

  try {
    const obj = await env.DOCS.get(attachment.r2_key);
    if (!obj) throw new Error('Document file missing in R2.');

    // Plain-text-shaped formats: read directly from R2 without
    // round-tripping through ConvertAPI. Saves a paid API call and
    // a few hundred ms.
    if (ext === 'txt' || ext === 'md' || ext === 'csv' || ext === 'tsv'
        || ext === 'log' || ext === 'json' || ext === 'xml' || ext === 'html') {
      const text = await obj.text();
      await markReady(env.DB, attachment.id, text, 'r2-direct');
      return text;
    }

    // Everything else needs ConvertAPI. Map our extension to the
    // ConvertAPI 'from' format. Anything unrecognized is rejected.
    const FROM_FORMAT = {
      pdf: 'pdf',
      docx: 'docx',
      doc: 'doc',
      rtf: 'rtf',
      odt: 'odt',
      ppt: 'ppt',
      pptx: 'pptx',
      xls: 'xls',
      xlsx: 'xlsx',
    };
    const fromFmt = FROM_FORMAT[ext];
    if (!fromFmt) {
      throw new Error(`Unsupported document format: .${ext}`);
    }

    const secret = env.CONVERTAPI_SECRET;
    if (!secret) {
      throw new Error('CONVERTAPI_SECRET is not configured');
    }

    const buffer = await obj.arrayBuffer();
    const url = `https://v2.convertapi.com/convert/${fromFmt}/to/txt?Secret=${secret}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${escapeHeaderFilename(filename)}"`,
      },
      body: buffer,
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`ConvertAPI failed (${resp.status}): ${errText.slice(0, 200)}`);
    }

    // ConvertAPI returns a JSON envelope when using octet-stream input
    // for text output: { Files: [{ FileName, FileExt, FileData (base64) }] }.
    // Parse and decode.
    const ct = resp.headers.get('content-type') || '';
    let text = '';
    if (ct.includes('application/json')) {
      const data = await resp.json();
      const fileData = data?.Files?.[0]?.FileData;
      if (!fileData) {
        throw new Error('ConvertAPI returned no file data');
      }
      text = atob(fileData);
    } else {
      text = await resp.text();
    }

    await markReady(env.DB, attachment.id, text, 'convertapi');
    return text;
  } catch (e) {
    await markError(env.DB, attachment.id, `Document extraction failed: ${e.message || e}`);
    throw e;
  }
}

function escapeHeaderFilename(name) {
  return String(name).replace(/[\r\n"]/g, '_').slice(0, 200);
}

async function processEmailStub(env, attachment) {
  const stub = `[Email attachment "${attachment.filename || 'unnamed'}" — .eml parsing not yet implemented (Phase D).]`;
  await markReady(env.DB, attachment.id, stub, 'stub');
  return stub;
}

async function processImageStub(env, attachment) {
  const stub = `[Image attachment "${attachment.filename || 'unnamed'}" — OCR not yet implemented (Phase D).]`;
  await markReady(env.DB, attachment.id, stub, 'stub');
  return stub;
}

// ---------------------------------------------------------------------
// Status helpers — single point of writes for the attachment lifecycle.
// ---------------------------------------------------------------------

async function markProcessing(db, id) {
  await run(db,
    'UPDATE ai_inbox_attachments SET status = ?, error_message = NULL, updated_at = ? WHERE id = ?',
    ['processing', now(), id]);
}

async function markReady(db, id, capturedText, model) {
  await run(db,
    `UPDATE ai_inbox_attachments
        SET status = 'ready', captured_text = ?, captured_text_model = ?,
            error_message = NULL, updated_at = ?
      WHERE id = ?`,
    [capturedText, model, now(), id]);
}

async function markError(db, id, message) {
  await run(db,
    `UPDATE ai_inbox_attachments
        SET status = 'error', error_message = ?, updated_at = ?
      WHERE id = ?`,
    [String(message).slice(0, 1000), now(), id]);
}

function guessExt(mime) {
  if (!mime) return 'm4a';
  const m = String(mime).toLowerCase();
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('flac')) return 'flac';
  if (m.includes('webm')) return 'webm';
  if (m.includes('mp4') || m.includes('m4a')) return 'm4a';
  return 'm4a';
}

// ---------------------------------------------------------------------
// Compiled context — concatenate all ready attachments in sort order
// with section headers, optionally pinning the primary first.
// ---------------------------------------------------------------------

const KIND_LABELS = {
  audio: 'Audio recording',
  text: 'User text',
  document: 'Document',
  email: 'Email',
  image: 'Image (OCR)',
};

/**
 * Given the rows from a `SELECT * FROM ai_inbox_attachments WHERE
 * entry_id = ? ORDER BY sort_order` query, build the system-friendly
 * combined text. The primary attachment (if any) is moved to the top
 * regardless of sort order, then everything else in sort order.
 *
 * Returns a string suitable for the user message of an extraction call.
 * Returns '' when no ready attachments exist.
 */
export function compileContext(attachments) {
  const ready = (attachments || []).filter(
    (a) => a.include_in_context !== 0 && a.status === 'ready' && a.captured_text
  );
  if (ready.length === 0) return '';

  // Move primary to the front; preserve relative order for the rest.
  const primary = ready.filter((a) => a.is_primary === 1);
  const rest = ready.filter((a) => a.is_primary !== 1);
  const ordered = [...primary, ...rest];

  return ordered
    .map((a) => {
      const label = KIND_LABELS[a.kind] || a.kind;
      const heading = a.filename ? `${label} — ${a.filename}` : label;
      return `=== ${heading} ===\n${a.captured_text}`;
    })
    .join('\n\n');
}
