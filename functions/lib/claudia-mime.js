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
//   * Keeps text/* leaves, drops binary leaves (PDFs, images,
//     application/* attachments, etc.).
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
//   * No attachment metadata extraction (we drop them entirely; the
//     R2 original keeps the bytes if we ever need them back).

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
  return {
    headers,
    contentType: contentType.type,
    contentTypeParams: contentType.params,
    body: decodeBody(body, encoding, contentType.params.charset),
  };
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
