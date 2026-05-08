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
import { extractAttachments, emailMetadata } from '../lib/claudia-mime.js';
import { one } from '../lib/db.js';
import { queueClaudiaEvent } from '../lib/claudia-events.js';

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

  // 5b. Dedup by RFC 5322 Message-Id. Same email re-sent from the
  // Outlook add-in (or arrived via another path) returns 200 with
  // duplicate:true instead of creating a new row + R2 object + Haiku
  // pass. The current message_id column is set on every email
  // ingested since migration 0081, so we only catch dupes against
  // post-0081 history — older ingests have null message_id and are
  // not protected. Trashed rows are excluded so re-ingesting a
  // previously-deleted email creates a fresh row (intentional —
  // user can deliberately re-add).
  const fullEmlText = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const incomingMeta = emailMetadata(fullEmlText);
  const incomingMessageId = incomingMeta?.message_id || null;
  if (incomingMessageId) {
    const existing = await one(
      env.DB,
      `SELECT id, seq, filename, category, created_at
         FROM claudia_documents
        WHERE user_id = ?
          AND message_id = ?
          AND retention != 'trashed'
        LIMIT 1`,
      [user.id, incomingMessageId]
    );
    if (existing) {
      return jsonResponse({
        ok: true,
        duplicate: true,
        document_id: existing.id,
        seq: existing.seq,
        filename: existing.filename,
        category: existing.category,
        first_seen_at: existing.created_at,
        message: 'Already on Claudia (#' + existing.seq + ')',
      });
    }
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

  // 6b. Extract attachments BEFORE the parent INSERT so we can
  // populate attachments_count in structured_data accurately.
  // extractAttachments now filters out unreferenced inline images
  // (signature logos, tracking pixels) — only image attachments
  // explicitly disposed as attachment OR inline images that the
  // text/html body actually references via cid: pass through.
  const attachments = extractAttachments(fullEmlText);

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
        category,
        sender_email, sender_name, subject, email_date, message_id,
        structured_data, parent_id,
        created_at, updated_at, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'auto', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?,
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
      incomingMeta?.sender_email || null,
      incomingMeta?.sender_name || null,
      incomingMeta?.subject || null,
      incomingMeta?.email_date || null,
      incomingMessageId,
      incomingMeta
        ? JSON.stringify({ kind: 'email', ...incomingMeta, attachments_count: attachments.length })
        : null,
      ts,
      ts,
      user.id,
    ]
  );

  // 7. Ingest each attachment as its own claudia_documents row. Same
  // pipeline as a drop-zone upload (R2 put → text extract → categorize
  // → INSERT with own seq). Best-effort per attachment: if one fails
  // we log it in the response and keep going on the rest.
  const attachmentResults = [];
  for (const att of attachments) {
    try {
      const attDocId = uuid();
      const attTs = now();
      const attSafeName = (att.filename || 'attachment')
        .replace(/[^A-Za-z0-9._-]+/g, '_')
        .slice(0, 120) || 'attachment';
      const attR2Key = `claudia-docs/${user.id}/${attDocId}/${attSafeName}`;

      await env.DOCS.put(attR2Key, att.bytes, {
        httpMetadata: { contentType: att.contentType },
        customMetadata: {
          uploaded_by: user.id,
          original_filename: att.filename,
          ingest_source: 'outlook_addin_attachment',
          parent_email_doc_id: docId,
        },
      });

      let attExtracted = { text: '', status: 'error', error: 'not run' };
      try {
        attExtracted = await extractText(env, att.bytes, att.contentType, att.filename);
      } catch (err) {
        attExtracted = { text: '', status: 'error', error: err?.message || String(err) };
      }

      let attCategory = null;
      try {
        attCategory = await categorizeDocument(env, {
          filename: att.filename,
          contentType: att.contentType,
          text: attExtracted.text,
          // Inherit parent context — "Fw: Head shot" → attachment is a
          // headshot, not generic. Big quality lift on image attachments
          // where the filename is opaque (UUID-style) and the content
          // is a binary blob with no extractable text.
          parentSubject: incomingMeta?.subject || null,
        });
      } catch (err) {
        console.error('[email-ingest] attachment categorize failed:', err?.message || err);
      }

      await run(
        env.DB,
        `INSERT INTO claudia_documents
           (id, user_id, filename, content_type, size_bytes, r2_key,
            full_text, retention, extraction_status, extraction_error,
            category,
            sender_email, sender_name, subject, email_date, message_id,
            structured_data, parent_id,
            created_at, updated_at, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'auto', ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?,
           COALESCE((SELECT MAX(seq) FROM claudia_documents WHERE user_id = ?), 0) + 1)`,
        [
          attDocId,
          user.id,
          att.filename,
          att.contentType,
          att.bytes.length,
          attR2Key,
          attExtracted.text || null,
          attExtracted.status,
          attExtracted.error || null,
          attCategory,
          JSON.stringify({ kind: 'attachment', from_email: docId }),
          docId,
          attTs,
          attTs,
          user.id,
        ]
      );

      attachmentResults.push({
        document_id: attDocId,
        filename: att.filename,
        content_type: att.contentType,
        bytes: att.bytes.length,
        category: attCategory,
        extraction_status: attExtracted.status,
      });
    } catch (err) {
      console.error('[email-ingest] attachment failed:', err?.message || err);
      attachmentResults.push({
        filename: att.filename,
        error: err?.message || String(err),
      });
    }
  }

  // Fan out to Claudia: one event per ingested email (parent doc).
  // Attachments don't need their own events — the action extractor's
  // enrichment can reach them via parent_id when relevant.
  const queueSummary = incomingMeta?.subject
    ? `Email "${incomingMeta.subject}"${incomingMeta?.sender_email ? ` from ${incomingMeta.sender_email}` : ''}`
    : `Email ${filename}`;
  await queueClaudiaEvent(env, user, 'document.email_ingested', docId, queueSummary);

  return jsonResponse({
    ok: true,
    document_id: docId,
    filename,
    category,
    extraction_status: extracted.status,
    bytes: bytes.length,
    attachments: attachmentResults,
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
