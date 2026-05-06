// functions/api/email-ingest.js
//
// POST /api/email-ingest — receive an .eml from the Outlook add-in
// (or any other ingest source that has the shared secret) and drop it
// into claudia_documents so Claudia can read it via her existing
// document tools.
//
// Auth model:
//   * Cloudflare Access bypass for this path. Wes adds a "Bypass" or
//     "Service Auth" policy in the Cloudflare Access dashboard so
//     requests to /api/email-ingest don't get the SSO redirect.
//   * Shared-secret check inside the Worker: requests must include
//     `Authorization: Bearer <env.OUTLOOK_ADDIN_SECRET>`.
//   * Defense-in-depth: the parsed message must claim to be from /
//     to / received by one of Wes's known email addresses (his work
//     email or his personal Gmail). Stops a leaked secret from being
//     used to inject random emails into his drop-zone.
//
// Body shape (JSON):
//   {
//     "mime_base64": "<base64-encoded raw .eml content>",
//     "filename":    "<optional> e.g. 'RE_ Acme RFQ.eml'"
//   }
//
// On success: { ok: true, document_id, filename, category }
// On auth/validation failure: 401 / 400 with a brief reason.
//
// MIME parsing reuses the existing helpers in lib/claudia-extract.js
// + lib/claudia-mime.js so the document looks identical to one
// dropped via the chat UI.

import { run } from '../lib/db.js';
import { now, uuid } from '../lib/ids.js';
import { extractText } from '../lib/claudia-extract.js';
import { categorizeDocument } from '../lib/claudia-categorize.js';
import { one } from '../lib/db.js';

// Wes's known email addresses for the recipient/sender check. Add to
// this list if he wants to ingest from another mailbox he owns.
const WES_KNOWN_EMAILS = new Set([
  'wes.yoakum@c-lars.com',
  'wesyoakum@gmail.com',
]);

const PIPELINE_USER_EMAIL = 'wes.yoakum@c-lars.com';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Outlook add-ins run in an iframe; CORS must allow them. Safe
      // because the auth gate is the shared secret, not the origin.
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'POST, OPTIONS',
    },
  });
}

export async function onRequestOptions() {
  // Preflight for the CORS request the Outlook iframe makes.
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-max-age': '86400',
    },
  });
}

export async function onRequestPost(context) {
  const { env, request } = context;

  // 1. Shared-secret check.
  const expected = env.OUTLOOK_ADDIN_SECRET || '';
  if (!expected) {
    return jsonResponse({ ok: false, error: 'server_not_configured' }, 500);
  }
  const auth = String(request.headers.get('authorization') || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!constantTimeEquals(token, expected)) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
  }

  // 2. Parse the body.
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ ok: false, error: 'invalid_json' }, 400);
  }
  const mimeB64 = String(body?.mime_base64 || '').trim();
  const filename = String(body?.filename || 'email.eml').trim() || 'email.eml';
  if (!mimeB64) {
    return jsonResponse({ ok: false, error: 'missing_mime_base64' }, 400);
  }

  // 3. Decode the MIME to bytes.
  let bytes;
  try {
    const bin = atob(mimeB64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch (err) {
    return jsonResponse({ ok: false, error: 'mime_decode_failed' }, 400);
  }
  if (bytes.length > 25 * 1024 * 1024) {
    return jsonResponse({ ok: false, error: 'too_large', max_bytes: 25 * 1024 * 1024 }, 413);
  }

  // 4. Recipient/sender sanity check. Best-effort header parse to
  // confirm one of Wes's addresses appears somewhere relevant. Stops
  // a leaked secret from injecting random unrelated emails.
  const headerText = new TextDecoder('utf-8').decode(bytes.slice(0, Math.min(bytes.length, 8192)));
  const headerLower = headerText.toLowerCase();
  let knownEmailMatched = false;
  for (const addr of WES_KNOWN_EMAILS) {
    if (headerLower.includes(addr.toLowerCase())) {
      knownEmailMatched = true;
      break;
    }
  }
  if (!knownEmailMatched) {
    return jsonResponse({
      ok: false,
      error: 'unknown_recipient',
      message: 'Email does not appear to involve any known Wes address. Add the new address to WES_KNOWN_EMAILS in functions/api/email-ingest.js if it should be allowed.',
    }, 403);
  }

  // 5. Look up Wes's user_id (the document needs an owner).
  const user = await one(
    env.DB,
    'SELECT id FROM users WHERE email = ? LIMIT 1',
    [PIPELINE_USER_EMAIL]
  );
  if (!user) {
    return jsonResponse({ ok: false, error: 'pipeline_user_not_found' }, 500);
  }

  // 6. Stream to R2 + extract text + categorize, mirroring the
  // upload endpoint's flow so the resulting document looks identical
  // to one dropped via the chat UI.
  const docId = uuid();
  const safeName = filename.replace(/[^A-Za-z0-9._-]+/g, '_');
  const r2Key = `claudia-docs/${user.id}/${docId}/${safeName}`;
  await env.DOCS.put(r2Key, bytes, {
    httpMetadata: { contentType: 'message/rfc822' },
    customMetadata: {
      uploaded_by: user.id,
      original_filename: filename,
      ingest_source: 'outlook_addin',
    },
  });

  let extracted = { text: '', status: 'error', error: 'not run' };
  try {
    extracted = await extractText(env, bytes, 'message/rfc822', filename);
  } catch (err) {
    extracted = { text: '', status: 'error', error: err?.message || String(err) };
  }

  let category = null;
  try {
    category = await categorizeDocument(env, {
      filename,
      contentType: 'message/rfc822',
      text: extracted.text,
    });
  } catch (err) {
    console.error('[email-ingest] categorize failed:', err?.message || err);
  }

  const ts = now();
  // seq via correlated subquery — atomic per-user "next number".
  // The UNIQUE INDEX on (user_id, seq) catches the rare race where
  // two concurrent inserts compute the same MAX; the loser surfaces
  // a constraint violation and the add-in retries.
  await run(
    env.DB,
    `INSERT INTO claudia_documents
       (id, user_id, filename, content_type, size_bytes, r2_key,
        full_text, retention, extraction_status, extraction_error,
        category, created_at, updated_at, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'auto', ?, ?, ?, ?, ?,
       COALESCE((SELECT MAX(seq) FROM claudia_documents WHERE user_id = ?), 0) + 1)`,
    [
      docId,
      user.id,
      filename,
      'message/rfc822',
      bytes.length,
      r2Key,
      extracted.text || null,
      extracted.status,
      extracted.error || null,
      category,
      ts,
      ts,
      user.id,
    ]
  );

  return jsonResponse({
    ok: true,
    document_id: docId,
    filename,
    category,
    extraction_status: extracted.status,
    bytes: bytes.length,
  });
}

function constantTimeEquals(a, b) {
  const sa = String(a || '');
  const sb = String(b || '');
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) {
    diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  }
  return diff === 0;
}
