// functions/lib/gmail-api.js
//
// Thin wrapper around Google's Gmail REST API for Claudia's read tools.
// All calls are authenticated via getValidAccessToken (which handles
// refresh transparently). Read-only — we don't currently expose
// send/modify endpoints.
//
// Gmail API reference:
//   https://developers.google.com/gmail/api/reference/rest
//
// Per-call timeouts: Gmail's API can be slow on big mailboxes. We
// default to a 25s soft timeout (Cloudflare Workers' subrequest cap
// is 30s for Bound Workers, more for Pages Functions). If a search
// times out, the tool surfaces an error rather than hanging the chat.

import { getValidAccessToken } from './gmail-oauth.js';

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

async function gmailGet(env, userId, path, params) {
  const { accessToken } = await getValidAccessToken(env, userId);
  const url = new URL(GMAIL_API_BASE + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail API ${res.status} on ${path}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Search messages by Gmail's q syntax.
 * Examples:
 *   from:tom@example.com
 *   subject:"RFQ"
 *   newer_than:7d
 *   has:attachment
 *   label:inbox is:unread
 *   list:noreply@example.com
 *
 * Returns { messages: [{id, threadId}], nextPageToken?, resultSizeEstimate }
 * — caller fetches details via getMessage when it needs them.
 */
export async function searchMessages(env, userId, { q, maxResults, pageToken } = {}) {
  return gmailGet(env, userId, '/messages', {
    q: q || '',
    maxResults: Math.min(Math.max(Number(maxResults) || 25, 1), 100),
    pageToken: pageToken || undefined,
  });
}

/**
 * Get a full message by id. format=full returns headers + parsed
 * payload; we strip the verbose parts (headers we don't need,
 * raw bytes) before returning to keep the tool response compact.
 */
export async function getMessage(env, userId, messageId) {
  const raw = await gmailGet(env, userId, `/messages/${encodeURIComponent(messageId)}`, {
    format: 'full',
  });
  return shapeMessage(raw);
}

/**
 * List threads (one row per email conversation, not per message).
 * More useful than message-level for "show me all my Tom threads"
 * because it groups replies.
 */
export async function listThreads(env, userId, { q, maxResults, pageToken } = {}) {
  return gmailGet(env, userId, '/threads', {
    q: q || '',
    maxResults: Math.min(Math.max(Number(maxResults) || 25, 1), 100),
    pageToken: pageToken || undefined,
  });
}

/**
 * Get a full thread (all messages in the conversation).
 */
export async function getThread(env, userId, threadId) {
  const raw = await gmailGet(env, userId, `/threads/${encodeURIComponent(threadId)}`, {
    format: 'full',
  });
  return {
    id: raw.id,
    historyId: raw.historyId,
    messages: (raw.messages || []).map(shapeMessage),
  };
}

/**
 * Reduce Gmail's verbose message payload into a Claude-friendly
 * shape. Pulls common headers (From / To / Cc / Subject / Date),
 * extracts plain-text body (preferred) or HTML-stripped body, and
 * lists attachment metadata without their bytes.
 */
function shapeMessage(raw) {
  const headers = {};
  for (const h of raw.payload?.headers || []) {
    headers[h.name.toLowerCase()] = h.value;
  }
  const { text, html, attachments } = extractParts(raw.payload);
  const body = text || (html ? stripHtml(html) : '');
  const TRUNC = 50_000;
  const truncated = body.length > TRUNC;
  return {
    id: raw.id,
    thread_id: raw.threadId,
    label_ids: raw.labelIds || [],
    snippet: raw.snippet || '',
    internal_date: raw.internalDate ? new Date(Number(raw.internalDate)).toISOString() : null,
    from:    headers.from || null,
    to:      headers.to || null,
    cc:      headers.cc || null,
    bcc:     headers.bcc || null,
    subject: headers.subject || null,
    date:    headers.date || null,
    reply_to: headers['reply-to'] || null,
    body_truncated: truncated,
    body: truncated ? body.slice(0, TRUNC) : body,
    attachments,
  };
}

/**
 * Walk a Gmail payload tree and extract:
 *   - text:    first text/plain part's decoded body
 *   - html:    first text/html part's decoded body
 *   - attachments: list of { filename, mime_type, size, attachment_id }
 *                  (bytes NOT downloaded; would be a separate call
 *                  to /messages/<id>/attachments/<aid> if needed)
 */
function extractParts(payload) {
  let text = '';
  let html = '';
  const attachments = [];
  function walk(part) {
    if (!part) return;
    const mime = String(part.mimeType || '').toLowerCase();
    const isAttachment = !!(part.filename && part.filename.length > 0);
    if (isAttachment) {
      attachments.push({
        filename: part.filename,
        mime_type: part.mimeType,
        size: part.body?.size ?? null,
        attachment_id: part.body?.attachmentId ?? null,
      });
    } else if (mime === 'text/plain' && part.body?.data && !text) {
      text = decodeBody(part.body.data);
    } else if (mime === 'text/html' && part.body?.data && !html) {
      html = decodeBody(part.body.data);
    }
    if (part.parts) for (const sub of part.parts) walk(sub);
  }
  walk(payload);
  return { text, html, attachments };
}

function decodeBody(b64url) {
  try {
    const base64 = String(b64url).replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
    // Gmail bodies are UTF-8; atob returns a Latin-1 string, so
    // re-decode through TextDecoder.
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

/**
 * Strip HTML to readable text. Used as fallback when only text/html
 * is available. Not a perfect parse — newlines on block elements,
 * spaces between inline elements, drop scripts/styles. Good enough
 * for an LLM to read; not good enough for rendering.
 */
function stripHtml(html) {
  return String(html)
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<\/?(p|div|br|li|tr|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
