// functions/ai-inbox/[id]/push/attachment.js
//
// POST /ai-inbox/:id/push/attachment
//
// Pushes an entry attachment (a file already stored in R2 with a
// captured-text record) into the documents table at the chosen
// CRM target's scope. The R2 key is shared between AI Inbox and
// documents — no copy needed; we just write a new documents row
// pointing at the same key. Auto-associates the entry to the
// target.
//
// kind='text' attachments are rejected because they have no R2 file.
// Use /push/note for those.
//
// Body (JSON):
//   { ref_type, ref_id, attachment_id }

import { one, stmt, batch } from '../../../lib/db.js';
import { auditStmt } from '../../../lib/audit.js';
import { uuid, now } from '../../../lib/ids.js';
import {
  loadPushContext,
  isAlreadyAssociated,
  buildPushLinkStatements,
} from '../../lib/push-helpers.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;

  let payload;
  try { payload = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const refType = String(payload.ref_type || '').trim();
  const refId = String(payload.ref_id || '').trim();
  const attachmentId = String(payload.attachment_id || '').trim();

  if (!refType || !refId) return json({ ok: false, error: 'ref_required' }, 400);
  if (!attachmentId) return json({ ok: false, error: 'attachment_id_required' }, 400);

  const ctx = await loadPushContext(env, user, params.id, refType, refId);
  if (ctx.error) return json({ ok: false, error: ctx.error }, ctx.status || 400);

  // Look up the attachment, verify it belongs to this entry, and
  // confirm it has an R2 file (text-only attachments have no file
  // and should be pushed via /push/note instead).
  const att = await one(env.DB,
    `SELECT id, kind, r2_key, mime_type, size_bytes, filename
       FROM ai_inbox_attachments
      WHERE id = ? AND entry_id = ?`,
    [attachmentId, params.id]);
  if (!att) return json({ ok: false, error: 'attachment_not_found' }, 404);
  if (!att.r2_key) {
    return json({ ok: false, error: 'attachment_has_no_file', hint: 'use /push/note for text attachments' }, 400);
  }

  // Map ref_type → documents column. documents schema has nullable
  // FKs to opportunity_id / account_id / contact_id / quote_id /
  // job_id; we set whichever matches the target.
  const oppId = refType === 'opportunity' ? refId : null;
  const accountId = refType === 'account' ? refId : null;
  const contactId = refType === 'contact' ? refId : null;
  const quoteId = refType === 'quote' ? refId : null;

  const docId = uuid();
  const ts = now();
  const docTitle = (att.filename || `attachment-${attachmentId}`);

  // documents has nullable polymorphic FKs; we set whichever matches
  // the chosen target.
  const sql = `
    INSERT INTO documents (
      id, opportunity_id, account_id, contact_id, quote_id, job_id,
      title, kind, r2_key, mime_type, size_bytes, original_filename,
      uploaded_at, uploaded_by_user_id
    )
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const alreadyAssoc = await isAlreadyAssociated(env.DB, params.id, refType, refId);
  const pushAction = `push_attachment_to_${refType}`;
  const pushLinks = buildPushLinkStatements(env.DB, user, params.id, {
    action_type: pushAction,
    ref_type: refType,
    ref_id: refId,
    ref_label: ctx.refLabel,
  }, alreadyAssoc);

  const stmts = [
    stmt(env.DB, sql, [
      docId, oppId, accountId, contactId, quoteId,
      docTitle, att.kind, att.r2_key, att.mime_type, att.size_bytes, att.filename,
      ts, user.id,
    ]),
    auditStmt(env.DB, {
      entityType: 'document',
      entityId: docId,
      eventType: 'created',
      user,
      summary: `Pushed file from AI Inbox: ${docTitle}`,
    }),
    ...pushLinks.statements,
  ];
  await batch(env.DB, stmts);

  return json({
    ok: true,
    document_id: docId,
    links: {
      associate: pushLinks.associateLinkRow,
      push: pushLinks.pushLinkRow,
    },
  });
}
