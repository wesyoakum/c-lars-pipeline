// functions/lib/claudia-extract.js
//
// Extract plain text from a file uploaded to Claudia's drop-zone.
// Three content paths:
//
//   * text/plain, text/markdown, application/json, etc. — direct UTF-8
//     decode of the bytes.
//   * application/vnd.openxmlformats-officedocument.wordprocessingml.document
//     (.docx) — unzip with PizZip, pull <w:t> nodes out of
//     word/document.xml, concatenate.
//   * application/pdf — send the PDF to Claude as a `document` content
//     block and ask for plain-text extraction. Adds one model call per
//     upload but avoids a 1MB+ PDF parser dependency and handles tables,
//     scanned docs, and weird layouts better than most JS parsers.
//
// Returns { text, status: 'ready' | 'partial' | 'error', error? }.
// Caller should always store whatever `text` came back even on partial /
// error, so something is searchable; the status flag tells the UI
// whether to flag the row visibly.

import PizZip from 'pizzip';
import * as XLSX from 'xlsx';
import { aiBaseUrl, gatewayHeaders } from './ai-gateway.js';
import { transcribeAudio } from './openai.js';
import { emailToReadableText } from './claudia-mime.js';

const ANTHROPIC_VERSION = '2023-06-01';
const PDF_EXTRACT_MODEL = 'claude-haiku-4-5-20251001'; // fast + cheap; full text dump doesn't need Sonnet
const IMAGE_DESCRIBE_MODEL = 'claude-haiku-4-5-20251001';

// D1 has a per-cell size limit of ~1 MB. We cap full_text at 750 KB to
// leave headroom for the row's other columns and any JSON encoding
// overhead; anything bigger is truncated and the row is marked partial.
const MAX_FULL_TEXT_CHARS = 750_000;

const TEXT_LIKE_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/tab-separated-values',
  'text/html',
  'text/xml',
  'application/json',
  'application/xml',
  // Email files: .eml is plain MIME (headers + body in clear text), and
  // .mbox is just N RFC822 messages concatenated. Both are readable as
  // text — basic dedupe / summarization works without a full MIME parser.
  // Attachments come through as base64 noise inside the body; that's
  // acceptable for the "find the email where X said Y" use case.
  'message/rfc822',
  'application/mbox',
]);

const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const XLSX_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
]);
const XLSX_EXTS = new Set(['xlsx', 'xls', 'xlsm']);

const AUDIO_TYPE_PREFIXES = ['audio/'];
const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'mp4', 'ogg', 'oga', 'flac', 'webm', 'aac', 'wma']);

/**
 * Decide whether a content type is one we know how to extract.
 * Returns the extractor kind or null.
 */
export function classifyContentType(contentType, filename) {
  const ct = String(contentType || '').toLowerCase();
  const ext = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (TEXT_LIKE_TYPES.has(ct)) return 'text';
  if (ct === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (
    ct === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === 'docx'
  ) {
    return 'docx';
  }
  if (IMAGE_TYPES.has(ct) || IMAGE_EXTS.has(ext)) return 'image';
  if (XLSX_TYPES.has(ct) || XLSX_EXTS.has(ext)) return 'xlsx';
  if (AUDIO_TYPE_PREFIXES.some((p) => ct.startsWith(p)) || AUDIO_EXTS.has(ext)) return 'audio';
  // Unknown content types but with a text-ish extension → treat as text.
  if (['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'xml', 'yaml', 'yml', 'eml', 'mbox'].includes(ext)) return 'text';
  return null;
}

/**
 * Detect a zip archive (by content type or .zip extension). Used by the
 * upload endpoint to expand zips into their constituent files BEFORE
 * the per-file ingest loop runs. Each inner file becomes its own
 * claudia_documents row.
 */
export function isZip(contentType, filename) {
  const ct = String(contentType || '').toLowerCase();
  const ext = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  return ct === 'application/zip' || ct === 'application/x-zip-compressed' || ext === 'zip';
}

/**
 * Expand a zip buffer into an array of File-like entries. Filters out
 * directories, macOS metadata (__MACOSX/, .DS_Store), and obviously
 * empty entries. Each returned entry is a real File so the upload
 * loop can treat it identically to a top-level upload.
 *
 * Throws if the buffer isn't a valid zip.
 */
export function expandZip(buffer) {
  const zip = new PizZip(buffer);
  const entries = [];
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    if (name.startsWith('__MACOSX/')) continue;
    if (name.endsWith('/.DS_Store') || name === '.DS_Store') continue;
    const baseName = name.replace(/^.*[\\/]/, '');
    if (!baseName) continue;
    const data = entry.asUint8Array();
    if (!data || data.length === 0) continue;
    // Best-effort content type from the inner filename. Workers' File
    // ctor takes (parts, name, options) — we leave .type unset for many
    // formats and let classifyContentType resolve them by extension.
    const guessedType = guessTypeFromExt(baseName) || '';
    entries.push(new File([data], baseName, { type: guessedType }));
  }
  return entries;
}

/**
 * Detect an mbox archive (Berkeley format — N RFC822 messages
 * concatenated, separated by lines that start with "From "). The
 * upload endpoint expands these into N individual .eml entries so
 * each email becomes its own claudia_documents row.
 */
export function isMbox(contentType, filename) {
  const ct = String(contentType || '').toLowerCase();
  const ext = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  return ct === 'application/mbox' || ext === 'mbox';
}

/**
 * Split an mbox buffer into File entries — one per message. Each
 * returned File has type 'message/rfc822' and a name derived from
 * the message's Subject header (sanitized + truncated). The
 * "From " separator line itself is dropped from each message; any
 * ">From " quoting in the body is unescaped per Berkeley format.
 */
export function expandMbox(buffer) {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  const lines = text.split(/\r?\n/);
  const messages = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = i > 0 ? lines[i - 1] : null;
    // mbox separator: "From " at the start of a line, AND either it's
    // the first line of the file or the previous line was blank. The
    // blank-line check is the standard way to disambiguate from "From "
    // appearing inside a message body.
    const isSeparator = line.startsWith('From ') && (i === 0 || prev === '');
    if (isSeparator) {
      if (current && current.length > 0) messages.push(current.join('\n'));
      current = [];
      continue;
    }
    if (current !== null) {
      // Unescape ">From " back to "From " (Berkeley quoting). The
      // standard escapes any leading ">*From " by adding one '>'.
      current.push(line.replace(/^>(>*)From /, '$1From '));
    }
  }
  if (current && current.length > 0) messages.push(current.join('\n'));

  return messages.map((body, idx) => {
    const subjMatch = body.match(/^Subject:\s*(.{1,80})/im);
    const safeSubj = subjMatch
      ? subjMatch[1].replace(/[^\w\s.-]+/g, '_').replace(/\s+/g, '_').trim().slice(0, 50)
      : `message_${idx + 1}`;
    const name = `${String(idx + 1).padStart(3, '0')}-${safeSubj || 'message'}.eml`;
    return new File([body], name, { type: 'message/rfc822' });
  });
}

function guessTypeFromExt(name) {
  const ext = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  switch (ext) {
    case 'eml':       return 'message/rfc822';
    case 'mbox':      return 'application/mbox';
    case 'pdf':       return 'application/pdf';
    case 'docx':      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'xlsx':      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'png':       return 'image/png';
    case 'jpg':
    case 'jpeg':      return 'image/jpeg';
    case 'gif':       return 'image/gif';
    case 'webp':      return 'image/webp';
    case 'csv':       return 'text/csv';
    case 'tsv':       return 'text/tab-separated-values';
    case 'json':      return 'application/json';
    case 'txt':
    case 'md':
    case 'markdown':
    case 'log':
    case 'yaml':
    case 'yml':
    case 'xml':       return 'text/plain';
    default:          return '';
  }
}

/**
 * Extract text from a buffer based on its content type.
 *
 * @param {Object} env
 * @param {ArrayBuffer} buffer
 * @param {string} contentType
 * @param {string} filename
 * @returns {Promise<{text: string, status: 'ready'|'partial'|'error', error?: string}>}
 */
export async function extractText(env, buffer, contentType, filename) {
  const kind = classifyContentType(contentType, filename);
  if (!kind) {
    return {
      text: '',
      status: 'error',
      error: `Unsupported content type: ${contentType || '(none)'} for ${filename}`,
    };
  }

  try {
    if (kind === 'text') {
      let text = new TextDecoder('utf-8', { fatal: false }).decode(buffer).trim();
      // Email-like content (.eml, .mbox-individual-message,
      // message/rfc822) goes through a real MIME parser:
      // walks multipart trees, decodes base64 / quoted-printable,
      // keeps text/* leaves, drops binary attachments cleanly.
      // Falls back to the regex strip-base64 heuristic if parsing
      // returns null (malformed, missing boundary, etc.).
      if (looksLikeEmail(contentType, filename)) {
        const parsed = emailToReadableText(text);
        text = (parsed && parsed.length > 0) ? parsed : stripBase64Blocks(text);
      }
      return capExtractedText({ text, status: 'ready' });
    }
    if (kind === 'docx') {
      const text = extractDocxText(buffer);
      return capExtractedText({ text, status: text ? 'ready' : 'partial' });
    }
    if (kind === 'pdf') {
      const text = await extractPdfTextViaClaude(env, buffer);
      return capExtractedText({ text, status: text ? 'ready' : 'partial' });
    }
    if (kind === 'image') {
      const text = await extractImageDescriptionViaClaude(env, buffer, contentType, filename);
      return capExtractedText({ text, status: text ? 'ready' : 'partial' });
    }
    if (kind === 'xlsx') {
      const text = extractXlsxText(buffer);
      return capExtractedText({ text, status: text ? 'ready' : 'partial' });
    }
    if (kind === 'audio') {
      const text = await extractAudioTranscript(env, buffer, contentType, filename);
      return capExtractedText({ text, status: text ? 'ready' : 'partial' });
    }
  } catch (err) {
    return {
      text: '',
      status: 'error',
      error: err?.message || String(err),
    };
  }
  return { text: '', status: 'error', error: 'unreachable' };
}

function looksLikeEmail(contentType, filename) {
  const ct = String(contentType || '').toLowerCase();
  if (ct === 'message/rfc822' || ct === 'application/mbox') return true;
  const ext = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return ext === 'eml' || ext === 'mbox';
}

/**
 * Heuristically strip base64-encoded attachment bodies from a MIME
 * blob. Looks for runs of 4+ consecutive lines that match a base64
 * line shape (60–80 chars of base64 alphabet) and replaces them with
 * a single placeholder. Imperfect by design — won't strip every
 * possible MIME pathology — but reliably catches the common case
 * where Outlook attaches a PDF or image and inflates the .eml into
 * a multi-MB file that won't fit in a D1 cell.
 */
function stripBase64Blocks(text) {
  return text.replace(
    /(?:^[A-Za-z0-9+/=]{60,80}\r?\n){4,}[A-Za-z0-9+/]{0,80}={0,2}\r?\n?/gm,
    '\n[base64 attachment block stripped for storage]\n'
  );
}

function capExtractedText(result) {
  if (!result || typeof result.text !== 'string') return result;
  if (result.text.length <= MAX_FULL_TEXT_CHARS) return result;
  return {
    ...result,
    text: result.text.slice(0, MAX_FULL_TEXT_CHARS),
    status: result.status === 'ready' ? 'partial' : result.status,
    error: result.error
      ? result.error + ' Also truncated to ' + MAX_FULL_TEXT_CHARS + ' chars (D1 cell limit).'
      : 'Truncated to ' + MAX_FULL_TEXT_CHARS + ' chars (D1 cell limit).',
  };
}

// ---------- DOCX ----------

function extractDocxText(buffer) {
  const zip = new PizZip(buffer);
  const docXml = zip.file('word/document.xml')?.asText();
  if (!docXml) return '';
  // Pull all <w:t>...</w:t> contents and join with spaces. Paragraphs
  // (<w:p>) become newlines. Good enough for search and LLM context;
  // ignores formatting / tables / images.
  const parts = [];
  // Paragraph-aware: split on </w:p>, then within each paragraph harvest <w:t>.
  const paragraphs = docXml.split(/<\/w:p>/);
  for (const para of paragraphs) {
    const matches = para.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
    const text = matches
      .map((m) => m.replace(/<w:t[^>]*>/, '').replace(/<\/w:t>/, ''))
      .join('')
      .trim();
    if (text) parts.push(text);
  }
  return decodeHtmlEntities(parts.join('\n')).trim();
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

// ---------- PDF (via Claude document content block) ----------

async function extractPdfTextViaClaude(env, buffer) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not configured for PDF extraction.');
  const base64 = bufferToBase64(buffer);
  const body = {
    model: env.ANTHROPIC_PDF_EXTRACT_MODEL || PDF_EXTRACT_MODEL,
    max_tokens: 8192,
    temperature: 0,
    system:
      'You convert documents to plain text. Output ONLY the extracted text from the document, ' +
      'in reading order. No preamble, no commentary, no markdown formatting beyond what the ' +
      'document itself uses. Preserve paragraph breaks. Skip page numbers and running ' +
      'headers/footers if they are clearly navigational. If a section is illegible, write ' +
      '[illegible] in its place rather than guessing.',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: base64 },
          },
          { type: 'text', text: 'Extract the full text of this document.' },
        ],
      },
    ],
  };

  const url = `${aiBaseUrl(env, 'anthropic')}/messages`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
      ...gatewayHeaders(env),
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`PDF extraction failed (${resp.status}): ${detail.slice(0, 400)}`);
  }
  const data = await resp.json();
  const text = (data?.content || [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  return text;
}

// ---------- Images (via Claude vision) ----------

async function extractImageDescriptionViaClaude(env, buffer, contentType, filename) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not configured for image description.');
  const mediaType = normalizeImageMediaType(contentType, filename);
  const base64 = bufferToBase64(buffer);
  const body = {
    model: env.ANTHROPIC_IMAGE_MODEL || IMAGE_DESCRIBE_MODEL,
    max_tokens: 1500,
    temperature: 0,
    system:
      'You convert images to plain text for a search index and Q&A. Describe the image so the ' +
      'text is enough to answer questions about it later. Be specific. ' +
      'If the image contains text (signs, slides, screenshots, scanned pages, equipment labels, ' +
      'data sheets), transcribe ALL visible text verbatim — including numbers, units, model ' +
      'numbers, and dates. ' +
      'If it is a photograph, describe what is shown: subject, setting, key objects, any people ' +
      '(by role/position only, never identify by name), notable details. ' +
      'If it is a diagram, chart, or technical drawing, describe the structure (axes, sections, ' +
      'flow, layout) and call out every label and numeric value. ' +
      'Output PLAIN TEXT only — no markdown headings, no preamble, no commentary about being an ' +
      'AI. Begin with one sentence summarizing what the image is, then the details.',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 },
          },
          { type: 'text', text: `Filename: ${filename}\nDescribe this image.` },
        ],
      },
    ],
  };

  const url = `${aiBaseUrl(env, 'anthropic')}/messages`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
      ...gatewayHeaders(env),
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Image description failed (${resp.status}): ${detail.slice(0, 400)}`);
  }
  const data = await resp.json();
  return (data?.content || [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

function normalizeImageMediaType(contentType, filename) {
  const ct = String(contentType || '').toLowerCase();
  if (IMAGE_TYPES.has(ct) && ct !== 'image/jpg') return ct;
  const ext = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg' || ct === 'image/jpg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  return 'image/png'; // safe fallback
}

// ---------- Audio (Whisper / gpt-4o-transcribe) ----------

async function extractAudioTranscript(env, buffer, contentType, filename) {
  // Re-wrap as a File so the existing transcribeAudio helper (which
  // appends to FormData under the key 'file') receives a proper Blob
  // with a sensible filename and content type.
  const blob = new File([buffer], filename || 'audio', {
    type: contentType || 'audio/mpeg',
  });
  const result = await transcribeAudio(env, blob);
  return (result?.text || '').trim();
}

// ---------- Spreadsheets (xlsx) ----------

function extractXlsxText(buffer) {
  const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' });
  const parts = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false }).trim();
    if (!csv) continue;
    parts.push(`# Sheet: ${sheetName}`);
    parts.push(csv);
    parts.push('');
  }
  return parts.join('\n').trim();
}

function bufferToBase64(buffer) {
  // Workers don't expose Buffer; use the chunked btoa approach.
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(bin);
}
