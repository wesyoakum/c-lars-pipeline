// functions/ai-inbox/[id]/push/task.js
//
// POST /ai-inbox/:id/push/task
//
// Pushes an entry's action_item as a task activity onto a CRM target.
// Auto-associates the entry to the target when not already linked.
//
// Body (JSON):
//   { ref_type, ref_id, action_idx?, subject?, body?, due_at? }
//   - ref_type: 'account' | 'contact' | 'opportunity'
//   - ref_id:   target id
//   - action_idx: index into the entry's action_items[]; if omitted,
//                 caller must supply subject (and optional body).
//   - subject/body/due_at: explicit overrides — when present, take
//                          precedence over action_items[action_idx]
//                          fields.
//
// Response:
//   { ok: true, activity_id, links: { associate?, push } }
//
// Note: this is the more-general successor to /actions/create-task.
// /actions/create-task still works (back-compat) but new callers
// should prefer /push/task because it auto-associates and supports
// contact-scope tasks via the contact_id column.

import { stmt, batch } from '../../../lib/db.js';
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

function deriveSubject(explicit, body) {
  const trimmedExplicit = (explicit || '').trim();
  if (trimmedExplicit) return trimmedExplicit;
  const trimmedBody = (body || '').trim();
  if (!trimmedBody) return '';
  const firstLine = trimmedBody.split(/\r?\n/)[0];
  if (firstLine.length <= 80) return firstLine;
  return firstLine.slice(0, 80) + '…';
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

  // Source the task body / subject / due from action_items[action_idx]
  // when present, with explicit payload fields taking precedence.
  let extracted = null;
  try { extracted = JSON.parse(ctx.entry.extracted_json || '{}'); } catch { extracted = {}; }
  const actions = Array.isArray(extracted.action_items) ? extracted.action_items : [];
  const idx = Number.isInteger(payload.action_idx) ? payload.action_idx : -1;
  const sourceAction = idx >= 0 && idx < actions.length ? actions[idx] : null;

  const subject = deriveSubject(
    payload.subject != null ? payload.subject : (sourceAction?.task || ''),
    payload.body != null ? payload.body : (sourceAction?.task || '')
  );
  if (!subject) return json({ ok: false, error: 'subject_required' }, 400);

  const taskBody = (payload.body != null ? String(payload.body) : '').trim() || null;
  const dueAt = (payload.due_at != null ? String(payload.due_at) : (sourceAction?.due || '')).trim() || null;

  const activityId = uuid();
  const ts = now();

  const oppId = refType === 'opportunity' ? refId : null;
  const accountId = refType === 'account' ? refId : null;
  const contactId = refType === 'contact' ? refId : null;

  const alreadyAssoc = await isAlreadyAssociated(env.DB, params.id, refType, refId);
  const pushAction = `push_task_to_${refType}`;
  const pushLinks = buildPushLinkStatements(env.DB, user, params.id, {
    action_type: pushAction,
    ref_type: refType,
    ref_id: refId,
    ref_label: subject.length > 80 ? subject.slice(0, 80) + '…' : subject,
  }, alreadyAssoc);

  const stmts = [
    stmt(env.DB,
      `INSERT INTO activities (
         id, opportunity_id, account_id, contact_id, quote_id, type, subject, body,
         direction, status, due_at, remind_at, assigned_user_id,
         created_at, updated_at, created_by_user_id
       )
       VALUES (?, ?, ?, ?, NULL, 'task', ?, ?, NULL, 'pending', ?, NULL, ?, ?, ?, ?)`,
      [activityId, oppId, accountId, contactId, subject, taskBody, dueAt, user.id, ts, ts, user.id]),
    auditStmt(env.DB, {
      entityType: 'activity',
      entityId: activityId,
      eventType: 'created',
      user,
      summary: `Pushed task from AI Inbox: ${subject}`,
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
