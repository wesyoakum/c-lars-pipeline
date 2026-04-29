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
import { messages, ANTHROPIC_MODELS } from '../lib/anthropic.js';

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
    case 'email':       return processEmail(env, attachment);
    case 'image':       return processImage(env, attachment);
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

async function processEmail(env, attachment) {
  if (!attachment.r2_key) {
    await markError(env.DB, attachment.id, 'Email attachment has no r2_key.');
    throw new Error('Email attachment has no r2_key.');
  }
  await markProcessing(env.DB, attachment.id);
  try {
    const obj = await env.DOCS.get(attachment.r2_key);
    if (!obj) throw new Error('Email file missing in R2.');
    const raw = await obj.text();
    const parsed = parseEml(raw);
    const captured = formatEmailForExtraction(parsed);
    await markReady(env.DB, attachment.id, captured, 'eml-parse');
    return captured;
  } catch (e) {
    await markError(env.DB, attachment.id, `Email parsing failed: ${e.message || e}`);
    throw e;
  }
}

// Lightweight RFC 5322 / MIME multipart parser. Handles the common
// cases:
//   * single-part email with text/plain body
//   * multipart/* — picks the first text/plain part
//   * quoted-printable encoded bodies
//   * header continuations (folded headers)
// Punts on:
//   * base64 / 8bit binary parts
//   * nested multipart trees beyond the first level
//   * non-utf8 charsets
// Good enough for common forwarded emails; extend later if needed.
function parseEml(raw) {
  const sepIdx = raw.search(/\r?\n\r?\n/);
  let headersBlock = sepIdx >= 0 ? raw.slice(0, sepIdx) : raw;
  let body = sepIdx >= 0 ? raw.slice(sepIdx).replace(/^[\r\n]+/, '') : '';

  // Unfold header continuations (per RFC 5322: a line beginning with
  // whitespace continues the previous header).
  headersBlock = headersBlock.replace(/\r?\n[ \t]+/g, ' ');

  const headers = {};
  for (const line of headersBlock.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z\-]+):\s*(.*)$/);
    if (m) headers[m[1].toLowerCase()] = m[2];
  }

  const contentType = (headers['content-type'] || '').toLowerCase();
  const transferEncoding = (headers['content-transfer-encoding'] || '').toLowerCase();

  if (contentType.startsWith('multipart/')) {
    const boundaryMatch = contentType.match(/boundary=("([^"]+)"|([^;\s]+))/);
    const boundary = boundaryMatch ? (boundaryMatch[2] || boundaryMatch[3]) : null;
    if (boundary) {
      const parts = body.split(new RegExp('--' + escapeRegex(boundary), 'g'));
      let pickedBody = '';
      let pickedEncoding = '';
      for (const part of parts) {
        const partSepIdx = part.search(/\r?\n\r?\n/);
        if (partSepIdx < 0) continue;
        const partHeaders = part.slice(0, partSepIdx).toLowerCase();
        const partBody = part.slice(partSepIdx).replace(/^[\r\n]+/, '');
        if (partHeaders.includes('content-type: text/plain')) {
          pickedBody = partBody;
          if (partHeaders.includes('content-transfer-encoding: quoted-printable')) {
            pickedEncoding = 'quoted-printable';
          }
          break;
        }
      }
      // Fall back to text/html if no plain part was found — better
      // than empty.
      if (!pickedBody) {
        for (const part of parts) {
          const partSepIdx = part.search(/\r?\n\r?\n/);
          if (partSepIdx < 0) continue;
          const partHeaders = part.slice(0, partSepIdx).toLowerCase();
          const partBody = part.slice(partSepIdx).replace(/^[\r\n]+/, '');
          if (partHeaders.includes('content-type: text/html')) {
            pickedBody = stripHtml(partBody);
            if (partHeaders.includes('content-transfer-encoding: quoted-printable')) {
              pickedEncoding = 'quoted-printable';
            }
            break;
          }
        }
      }
      body = pickedBody;
      if (pickedEncoding === 'quoted-printable') body = decodeQuotedPrintable(body);
    }
  } else if (transferEncoding === 'quoted-printable') {
    body = decodeQuotedPrintable(body);
  }

  // Trim trailing boundary lines / whitespace.
  body = body.replace(/^--.*$/gm, '').trim();

  return {
    from: headers.from || '',
    to: headers.to || '',
    cc: headers.cc || '',
    subject: headers.subject || '',
    date: headers.date || '',
    body,
  };
}

function decodeQuotedPrintable(s) {
  // Soft line breaks (=CRLF or =LF) are removed; =XX hex sequences
  // decode to their byte. Non-ASCII bytes after decode aren't
  // re-charset-decoded; that's OK for utf-8 source text in modern
  // emails.
  return s
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function stripHtml(s) {
  // Coarse: drop <script> / <style> blocks, then strip tags. Decode
  // a handful of common entities. Good enough to make HTML-only
  // emails extract-friendly without bringing in a real parser.
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n');
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatEmailForExtraction(p) {
  const lines = [];
  if (p.from) lines.push('From: ' + p.from);
  if (p.to) lines.push('To: ' + p.to);
  if (p.cc) lines.push('Cc: ' + p.cc);
  if (p.subject) lines.push('Subject: ' + p.subject);
  if (p.date) lines.push('Date: ' + p.date);
  if (lines.length) lines.push('');
  lines.push(p.body || '(no body)');
  return lines.join('\n');
}

async function processImage(env, attachment) {
  if (!attachment.r2_key) {
    await markError(env.DB, attachment.id, 'Image attachment has no r2_key.');
    throw new Error('Image attachment has no r2_key.');
  }
  await markProcessing(env.DB, attachment.id);
  try {
    const obj = await env.DOCS.get(attachment.r2_key);
    if (!obj) throw new Error('Image file missing in R2.');
    const buffer = await obj.arrayBuffer();

    // Anthropic vision wants base64-encoded bytes inline. Chunk the
    // conversion so a 5 MB photo doesn't blow the argument limit on
    // String.fromCharCode (which fails for very large argument lists).
    const base64 = arrayBufferToBase64(buffer);

    // Pick a sensible mime type. Anthropic accepts image/jpeg, png,
    // gif, webp; HEIC is not supported, so reject early with a clear
    // error rather than a 400 from upstream.
    const mime = (attachment.mime_type || '').toLowerCase();
    const supportedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!supportedMimes.includes(mime)) {
      const stub = `[Image attachment "${attachment.filename || 'unnamed'}" — unsupported format ${mime || 'unknown'}; OCR skipped. Convert to JPEG / PNG / GIF / WEBP and re-upload to extract text.]`;
      await markReady(env.DB, attachment.id, stub, 'stub-unsupported');
      return stub;
    }

    const model = env.AI_INBOX_OCR_MODEL || ANTHROPIC_MODELS.default;
    const result = await messages(env, {
      model,
      maxTokens: 4096,
      temperature: 0,
      system: [
        'You extract visible text from a single image. Output plain text only — no commentary, no markdown fences, no apologies.',
        'Preserve layout where it carries meaning: keep tabular data tab-separated, lists on separate lines, business-card sections together.',
        'If the image is a photo of a document (business card, sign, screenshot, whiteboard, RFQ page), extract every legible word.',
        'If the image has no readable text (a landscape photo, a logo without words, etc.), output a brief description of what is visible instead, prefixed with "[image:].',
        'If the image is genuinely empty or unreadable, output exactly: [image: no readable content].',
      ].join('\n'),
      user: [
        { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
        { type: 'text', text: 'Extract the visible text from this image.' },
      ],
    });

    const text = (result.text || '').trim() || '[image: no readable content]';
    await markReady(env.DB, attachment.id, text, 'claude-vision/' + result.model);
    return text;
  } catch (e) {
    await markError(env.DB, attachment.id, `Image OCR failed: ${e.message || e}`);
    throw e;
  }
}

function arrayBufferToBase64(buffer) {
  // Workers don't have Buffer; build the base64 string manually,
  // chunking through String.fromCharCode so we don't hit the
  // function-argument limit on large images.
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
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
      let heading = a.filename ? `${label} — ${a.filename}` : label;
      // When the attachment was created via "↳ Answer" on an open
      // question, encode the question into the section header so
      // the LLM sees the explicit Q/A pairing on the next extraction.
      if (a.answers_question) {
        heading += ` (answer to: "${String(a.answers_question).slice(0, 200)}")`;
      }
      return `=== ${heading} ===\n${a.captured_text}`;
    })
    .join('\n\n');
}
