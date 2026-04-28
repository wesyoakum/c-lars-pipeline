// functions/ai-inbox/[id]/push/note.js
//
// POST /ai-inbox/:id/push/note
//
// Pushes the entry's transcript or summary onto a CRM target as a
// note-type activity. Auto-associates the entry to the target when
// not already linked.
//
// Body (JSON):
//   { ref_type, ref_id, body? }
//   - ref_type: 'account' | 'contact' | 'opportunity'
//   - ref_id:   the target id
//   - body:     optional override; defaults to entry.summary, falling
//               back to entry.title, then a generic placeholder
//
// Response:
//   { ok: true, activity_id, links: { associate?, push } }

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

const NOTE_SUBJECT_MAX = 80;

function deriveSubject(body) {
  const trimmed = (body || '').trim();
  if (!trimmed) return '(note)';
  const firstLine = trimmed.split(/\r?\n/)[0];
  if (firstLine.length <= NOTE_SUBJECT_MAX) return firstLine;
  return firstLine.slice(0, NOTE_SUBJECT_MAX) + '…';
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;

  let payload;
  try { payload = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const refType = String(payload.ref_type || '').trim();
  const refId = String(payload.ref_id || '').trim();
  if (!refType || !refId) return json({ ok: false, error: 'ref_required' }, 400);

  const ctx = await loadPushContext(env, user, params.id, refType, refId);
  if (ctx.error) return json({ ok: false, error: ctx.error }, ctx.status || 400);

  // Body source: explicit > entry summary > entry title > placeholder.
  let extracted = null;
  try { extracted = JSON.parse(ctx.entry.extracted_json || '{}'); } catch { extracted = {}; }
  const explicitBody = typeof payload.body === 'string' ? payload.body.trim() : '';
  const noteBody = explicitBody
    || (extracted.summary || '').trim()
    || (extracted.title || '').trim()
    || 'Pushed from AI Inbox.';
  const subject = deriveSubject(noteBody);

  const activityId = uuid();
  const ts = now();

  // Build the activity insert. Polymorphic fields: only one of
  // opportunity_id / account_id / contact_id (etc) gets populated,
  // matching the link target.
  const oppId = refType === 'opportunity' ? refId : null;
  const accountId = refType === 'account' ? refId : null;
  const contactId = refType === 'contact' ? refId : null;

  const alreadyAssoc = await isAlreadyAssociated(env.DB, params.id, refType, refId);
  const pushAction = `push_note_to_${refType}`;
  const pushLinks = buildPushLinkStatements(env.DB, user, params.id, {
    action_type: pushAction,
    ref_type: refType,
    ref_id: refId,
    ref_label: ctx.refLabel,
  }, alreadyAssoc);

  const stmts = [
    stmt(env.DB,
      `INSERT INTO activities (
         id, opportunity_id, account_id, contact_id, quote_id, type, subject, body,
         direction, status, due_at, remind_at, assigned_user_id,
         created_at, updated_at, created_by_user_id
       )
       VALUES (?, ?, ?, ?, NULL, 'note', ?, ?, NULL, 'completed', NULL, NULL, ?, ?, ?, ?)`,
      [activityId, oppId, accountId, contactId, subject, noteBody, user.id, ts, ts, user.id]),
    auditStmt(env.DB, {
      entityType: 'activity',
      entityId: activityId,
      eventType: 'created',
      user,
      summary: `Pushed note from AI Inbox: ${subject}`,
    }),
    ...pushLinks.statements,
  ];
  await batch(env.DB, stmts);

  return json({
    ok: true,
    activity_id: activityId,
    links: {
      associate: pushLinks.associateLinkRow,
      push: pushLinks.pushLinkRow,
    },
  });
}
