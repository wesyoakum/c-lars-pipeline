// functions/lib/claudia-mime.js
//
// Lightweight pure-JS MIME parser used to turn raw .eml / .mbox
// content into clean readable text before storing it in D1. Replaces
// the regex-based stripBase64Blocks heuristic that was leaking on
// shorter base64 lines and quoted-printable encoded attachments.
//
// What this DOES:
//   * Splits headers from body and parses headers (case-insensitive).
//   * Walks multipart/* trees recursively, identifying each part.
//   * Decodes Content-Transfer-Encoding (base64, quoted-printable,
//     7bit/8bit/binary).
//   * Keeps text/* leaves as decoded strings (`emailToReadableText`).
//   * Keeps non-text leaves as raw bytes + filename so callers can
//     extract attachments separately (`extractAttachments`).
//   * Decodes RFC 2047 encoded-words ("=?UTF-8?B?...?=" /
//     "=?UTF-8?Q?...?=") in header values so non-ASCII Subject /
//     From lines come out readable.
//   * Crudely strips HTML tags from text/html parts when no
//     text/plain alternative is available.
//
// What this does NOT do (deliberate scope cut):
//   * No charset conversion beyond UTF-8 (modern email is mostly
//     UTF-8; rare Latin-1 / SJIS content may show garbled bytes).
//   * No signature / quote folding (replies still include "> ..."
//     quoted text — fine for search).
//   * No RFC 5987 filename* decoding (rare for English filenames;
//     plain filename= and name= cover the common cases).

const HEADER_KEYS_DISPLAYED = ['from', 'to', 'cc', 'subject', 'date', 'reply-to'];

/**
 * Top-level entry. Takes raw MIME (a single email — caller already
 * splits mbox files into individual messages) and returns a clean
 * readable plain-text rendering: a small header block followed by
 * the concatenated text/* part bodies.
 *
 * Returns null if parsing fails so the caller can fall back to a
 * heuristic. Returns '' if the message has no text body at all.
 */
export function emailToReadableText(rawMime) {
  if (!rawMime || typeof rawMime !== 'string') return null;
  let parsed;
  try {
    parsed = parseMime(rawMime);
  } catch {
    return null;
  }
  if (!parsed) return null;

  const headerBlock = renderHeaders(parsed.headers || {});
  const textParts = flattenTextParts(parsed);
  if (textParts.length === 0) {
    return headerBlock + (headerBlock ? '\n\n' : '') + '[no readable text body — attachments only]';
  }

  const bodyText = textParts
    .map((p) => {
      let t = p.body || '';
      if (p.contentType.startsWith('text/html')) t = stripHtml(t);
      return t.trim();
    })
    .filter(Boolean)
    .join('\n\n---\n\n');

  return headerBlock + (headerBlock ? '\n\n' : '') + bodyText;
}

/**
 * Walk the MIME tree and return every non-text leaf that looks like an
 * attachment, as `{ filename, contentType, bytes }`. Used by the
 * Outlook add-in's email-ingest path to surface attached PDFs / images
 * / spreadsheets as their own claudia_documents rows alongside the
 * parent .eml.
 *
 * Filters out tiny inline images (under 2KB) — these are almost always
 * signature logos or tracking pixels, not real content. Non-image
 * inline parts are kept (rare but legitimate, e.g. inline CSV).
 *
 * Returns [] on parse failure or when there are no attachments.
 */
export function extractAttachments(rawMime) {
  if (!rawMime || typeof rawMime !== 'string') return [];
  let parsed;
  try {
    parsed = parseMime(rawMime);
  } catch {
    return [];
  }
  if (!parsed) return [];
  return flattenAttachmentParts(parsed);
}

/**
 * Pull structured email metadata (sender, subject, date, message-id) out
 * of a raw .eml so the upload endpoint can store it in dedicated columns
 * — letting the renderer show "Subject — From · Date" without re-parsing
 * full_text on every render.
 *
 * Returns:
 *   { sender_email, sender_name, subject, email_date, message_id, in_reply_to }
 *   — any individual field may be null if the header is absent or unparseable.
 *
 * Returns null only if the input itself can't be parsed as MIME.
 */
export function emailMetadata(rawMime) {
  if (!rawMime || typeof rawMime !== 'string') return null;
  let parsed;
  try {
    parsed = parseMime(rawMime);
  } catch {
    return null;
  }
  if (!parsed) return null;
  const h = parsed.headers || {};

  const fromRaw = h['from'] || '';
  const { email: sender_email, name: sender_name } = splitAddress(decodeRfc2047(fromRaw));

  const subjectRaw = h['subject'] || '';
  const subject = subjectRaw ? decodeRfc2047(subjectRaw).trim() : null;

  const dateRaw = h['date'] || '';
  const email_date = normalizeDate(dateRaw);

  // Message-Id and In-Reply-To are wrapped in angle brackets per RFC 5322;
  // strip them for cleaner display + comparison.
  const message_id = stripAngles(h['message-id']) || null;
  const in_reply_to = stripAngles(h['in-reply-to']) || null;

  return {
    sender_email: sender_email || null,
    sender_name: sender_name || null,
    subject,
    email_date,
    message_id,
    in_reply_to,
  };
}

// "Wes Yoakum <wes@c-lars.com>" -> { name: "Wes Yoakum", email: "wes@c-lars.com" }
// "wes@c-lars.com"              -> { name: "",           email: "wes@c-lars.com" }
// "<wes@c-lars.com>"            -> { name: "",           email: "wes@c-lars.com" }
function splitAddress(s) {
  const str = String(s || '').trim();
  if (!str) return { name: '', email: '' };
  const m = str.match(/^(.*?)<\s*([^>]+?)\s*>\s*$/);
  if (m) {
    let name = m[1].trim();
    if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
    return { name, email: m[2].trim() };
  }
  // Bare address with no display name.
  if (/^[^\s@]+@[^\s@]+$/.test(str)) return { name: '', email: str };
  // Fallback: treat the whole thing as a name. Better than losing it.
  return { name: str, email: '' };
}

function stripAngles(s) {
  const str = String(s || '').trim();
  if (!str) return '';
  const m = str.match(/^<\s*(.+?)\s*>$/);
  return m ? m[1] : str;
}

// RFC 5322 dates parse cleanly with Date.parse() in modern V8.
// Fall back to the raw header on parse failure so the value isn't lost.
function normalizeDate(raw) {
  const str = String(raw || '').trim();
  if (!str) return null;
  const ms = Date.parse(str);
  if (Number.isFinite(ms)) return new Date(ms).toISOString();
  return str;
}

function flattenAttachmentParts(node) {
  if (!node) return [];
  if (Array.isArray(node.parts)) return node.parts.flatMap(flattenAttachmentParts);
  // Leaf. Text leaves don't carry rawBytes, so they fall through here.
  if (!node.rawBytes || node.rawBytes.length === 0) return [];

  const headers = node.headers || {};
  const dispRaw = headers['content-disposition'] || '';
  // parseContentType happens to match "type; key=value; ..." so it
  // works for Content-Disposition too — we only need the type token
  // and the filename param.
  const disp = parseContentType(dispRaw);
  const isAttachment = disp.type === 'attachment';
  const isInline = disp.type === 'inline';
  const isImage = String(node.contentType || '').toLowerCase().startsWith('image/');

  // Skip tiny inline images (signature logos, tracking pixels).
  if (isInline && isImage && node.rawBytes.length < 2 * 1024) return [];

  // Anything explicitly marked attachment OR a sized inline non-image
  // (rare but legitimate) gets surfaced. Default-disposition binary
  // parts (no Content-Disposition header at all) also flow through
  // here as long as they're large enough to be real content.
  const filenameRaw = disp.params.filename || node.contentTypeParams?.name || '';
  const filename = decodeRfc2047(filenameRaw) || `attachment.${guessExt(node.contentType)}`;

  if (!isAttachment && !filenameRaw && node.rawBytes.length < 2 * 1024) {
    // No disposition, no filename, tiny — almost certainly not real
    // content. Skip.
    return [];
  }

  return [{
    filename,
    contentType: node.contentType,
    bytes: node.rawBytes,
  }];
}

function guessExt(ct) {
  const c = String(ct || '').toLowerCase();
  const map = {
    'application/pdf': 'pdf',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'text/csv': 'csv',
    'text/plain': 'txt',
    'application/zip': 'zip',
  };
  return map[c] || 'bin';
}

/* ===================== Parsing core ===================== */

function parseMime(raw) {
  const { headers, body } = splitHeadersBody(raw);
  const contentType = parseContentType(headers['content-type'] || 'text/plain');
  const encoding = (headers['content-transfer-encoding'] || '7bit').toLowerCase().trim();

  if (contentType.type.startsWith('multipart/') && contentType.params.boundary) {
    const parts = splitMultipart(body, contentType.params.boundary);
    return {
      headers,
      contentType: contentType.type,
      contentTypeParams: contentType.params,
      parts: parts.map(parseMime).filter(Boolean),
    };
  }

  // text/* leaves get decoded into a string for the readable-text
  // pipeline. Non-text leaves keep raw bytes so extractAttachments
  // can pull them out — running them through bytesToString would
  // mangle the binary anyway, so we skip the decode entirely.
  if (contentType.type.startsWith('text/')) {
    return {
      headers,
      contentType: contentType.type,
      contentTypeParams: contentType.params,
      body: decodeBody(body, encoding, contentType.params.charset),
    };
  }
  return {
    headers,
    contentType: contentType.type,
    contentTypeParams: contentType.params,
    rawBytes: decodeBodyToBytes(body, encoding),
  };
}

// Decode a part body all the way to raw bytes (Uint8Array). Mirror of
// decodeBody() but skips the bytesToString step so binary content
// survives intact.
function decodeBodyToBytes(body, encoding) {
  if (encoding === 'base64') return base64ToBytes(body);
  if (encoding === 'quoted-printable') return quotedPrintableToBytes(body);
  // 7bit / 8bit / binary: char-code each character into a byte. Modern
  // email puts binary attachments in base64, so this branch is mostly
  // a fallback for malformed messages.
  const out = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i++) out[i] = body.charCodeAt(i) & 0xff;
  return out;
}

function splitHeadersBody(text) {
  // RFC 5322: headers and body separated by a single empty line.
  const sep = text.match(/\r?\n\r?\n/);
  if (!sep) return { headers: {}, body: text };
  const headerPart = text.slice(0, sep.index);
  const body = text.slice(sep.index + sep[0].length);

  // Header unfolding: continuation lines (starting with WS) join the prior line.
  const unfolded = headerPart.replace(/\r?\n[ \t]+/g, ' ');
  const headers = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).toLowerCase().trim();
    const value = line.slice(colon + 1).trim();
    headers[key] = value;
  }
  return { headers, body };
}

function parseContentType(headerValue) {
  // "type/subtype; param1=value1; param2=\"quoted value\""
  const segments = splitWithQuoted(headerValue, ';');
  const type = (segments[0] || 'text/plain').toLowerCase().trim();
  const params = {};
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i].trim();
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    const k = seg.slice(0, eq).toLowerCase().trim();
    let v = seg.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    params[k] = v;
  }
  return { type, params };
}

// Like split(';') but ignores ';' inside double-quoted strings.
function splitWithQuoted(s, sep) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') inQuotes = !inQuotes;
    if (c === sep && !inQuotes) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function splitMultipart(body, boundary) {
  // Body is split on lines equal to "--<boundary>"; the closing
  // delimiter is "--<boundary>--". Anything before the first
  // delimiter is preamble (preface text) and discarded.
  const open = '--' + boundary;
  const close = open + '--';
  const lines = body.split(/\r?\n/);
  const parts = [];
  let current = null;
  for (const line of lines) {
    const trimmed = line.replace(/\s+$/, ''); // boundaries can have trailing whitespace
    if (trimmed === open) {
      if (current !== null) parts.push(current.join('\r\n'));
      current = [];
    } else if (trimmed === close) {
      if (current !== null) parts.push(current.join('\r\n'));
      current = null;
      break;
    } else if (current !== null) {
      current.push(line);
    }
  }
  // Tolerate truncated / unclosed multiparts.
  if (current !== null && current.length > 0) parts.push(current.join('\r\n'));
  return parts;
}

/* ===================== Encoding decoders ===================== */

function decodeBody(body, encoding, charset) {
  let bytes;
  if (encoding === 'base64') {
    bytes = base64ToBytes(body);
  } else if (encoding === 'quoted-printable') {
    bytes = quotedPrintableToBytes(body);
  } else {
    // 7bit, 8bit, binary, unknown: treat the JS string's chars as
    // already-decoded text. We can't go to "bytes then UTF-8 decode"
    // here without a charset roundtrip, so trust the upstream UTF-8.
    return body;
  }
  return bytesToString(bytes, charset);
}

function base64ToBytes(s) {
  // atob is available in Cloudflare Workers. Strip whitespace first.
  const cleaned = s.replace(/[^A-Za-z0-9+/=]/g, '');
  try {
    const bin = atob(cleaned);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array(0);
  }
}

function quotedPrintableToBytes(s) {
  // First fold soft line breaks ("=\r\n" / "=\n"), then decode "=XX"
  // pairs into raw bytes, leaving everything else as their character
  // code (which is a 0–255 byte for ASCII-range chars).
  const folded = s.replace(/=\r?\n/g, '');
  const out = [];
  for (let i = 0; i < folded.length; i++) {
    const c = folded[i];
    if (c === '=' && i + 2 < folded.length) {
      const hex = folded.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    out.push(c.charCodeAt(0) & 0xff);
  }
  return new Uint8Array(out);
}

function bytesToString(bytes, charset) {
  // Default to UTF-8 for everything (>99% of modern email). A truly
  // non-UTF-8 charset (Latin-1, Shift-JIS) will come through with
  // replacement characters but headers/key terms are usually still
  // recognizable.
  const cs = (charset || 'utf-8').toLowerCase();
  try {
    const dec = new TextDecoder(cs, { fatal: false });
    return dec.decode(bytes);
  } catch {
    try {
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
      return '';
    }
  }
}

/* ===================== Header rendering ===================== */

function renderHeaders(headers) {
  const out = [];
  for (const k of HEADER_KEYS_DISPLAYED) {
    if (!headers[k]) continue;
    const decoded = decodeRfc2047(headers[k]);
    out.push(`${capitalizeKey(k)}: ${decoded}`);
  }
  return out.join('\n');
}

function capitalizeKey(k) {
  // "from" → "From", "reply-to" → "Reply-To"
  return k.replace(/(^|-)([a-z])/g, (_, sep, c) => sep + c.toUpperCase());
}

/**
 * Decode RFC 2047 encoded-words: =?charset?B?base64?= or =?charset?Q?qp?=
 * scattered through a header value. Anything that doesn't match the
 * pattern is left alone.
 */
function decodeRfc2047(s) {
  return String(s).replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, payload) => {
    let bytes;
    if (enc.toUpperCase() === 'B') {
      bytes = base64ToBytes(payload);
    } else {
      // RFC 2047's Q encoding is mostly QP but with "_" meaning space.
      const norm = payload.replace(/_/g, ' ');
      bytes = quotedPrintableToBytes(norm);
    }
    return bytesToString(bytes, charset);
  });
}

/* ===================== Tree flattening + HTML strip ===================== */

function flattenTextParts(node) {
  if (!node) return [];
  if (Array.isArray(node.parts)) {
    // For multipart/alternative, RFC 2045 says the LAST part is the
    // "best" representation. In practice for plain-vs-html, plain is
    // first and is a fine fallback. We return all text/* leaves and
    // de-dup is the caller's problem; simplest correct thing.
    return node.parts.flatMap(flattenTextParts);
  }
  if (typeof node.contentType === 'string' && node.contentType.startsWith('text/')) {
    return [{ contentType: node.contentType, body: node.body || '' }];
  }
  return [];
}

function stripHtml(html) {
  return String(html)
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Exposed for unit-test-style verification by callers if they want.
export const _internals = {
  parseMime,
  splitHeadersBody,
  parseContentType,
  splitMultipart,
  decodeBody,
  decodeRfc2047,
  stripHtml,
};
