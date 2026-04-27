// functions/ai-inbox/[id]/actions/create-task.js
//
// POST /ai-inbox/:id/actions/create-task
//
// Inserts an activity (type='task') and records an ai_inbox_links row
// pointing to it. Mirrors the existing INSERT pattern from
// functions/activities/index.js so the resulting row is indistinguishable
// from one created via the activities modal.
//
// Body (JSON):
//   { subject, body, account_id?, due_at?, assigned_user_id? }
//
// Response:
//   { ok: true, link, activity_id }     — link row in detail-page format
//   { ok: false, error }                — 400 on validation failure

import { one, stmt, batch } from '../../../lib/db.js';
import { auditStmt } from '../../../lib/audit.js';
import { uuid, now } from '../../../lib/ids.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// Subject is auto-derived from body if missing — same heuristic as
// functions/activities/index.js (first line, max 20 chars + ellipsis).
function deriveSubject(explicit, body) {
  const trimmedExplicit = (explicit || '').trim();
  if (trimmedExplicit) return trimmedExplicit;
  const trimmedBody = (body || '').trim();
  if (!trimmedBody) return '';
  const firstLine = trimmedBody.split(/\r?\n/)[0];
  if (firstLine.length <= 20) return firstLine;
  return firstLine.slice(0, 20) + '…';
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;

  // Verify ownership of the inbox item.
  const item = await one(
    env.DB,
    'SELECT id FROM ai_inbox_items WHERE id = ? AND user_id = ?',
    [params.id, user.id]
  );
  if (!item) return json({ ok: false, error: 'not_found' }, 404);

  let payload;
  try { payload = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const subject = deriveSubject(payload.subject, payload.body);
  if (!subject) return json({ ok: false, error: 'subject_required' }, 400);

  const taskBody = (payload.body || '').trim() || null;
  const accountId = (payload.account_id || '').trim() || null;
  const dueAt = (payload.due_at || '').trim() || null;
  const assignedUserId = (payload.assigned_user_id || '').trim() || user.id;

  const ts = now();
  const activityId = uuid();
  const linkId = uuid();
  const refLabel = subject.length > 80 ? subject.slice(0, 80) + '…' : subject;

  await batch(env.DB, [
    stmt(env.DB,
      `INSERT INTO activities (
         id, opportunity_id, account_id, quote_id, type, subject, body,
         direction, status, due_at, remind_at, assigned_user_id,
         created_at, updated_at, created_by_user_id
       )
       VALUES (?, NULL, ?, NULL, 'task', ?, ?, NULL, 'pending', ?, NULL, ?, ?, ?, ?)`,
      [activityId, accountId, subject, taskBody, dueAt, assignedUserId, ts, ts, user.id]),
    stmt(env.DB,
      `INSERT INTO ai_inbox_links
         (id, item_id, action_type, ref_type, ref_id, ref_label, created_at, created_by_user_id)
       VALUES (?, ?, 'create_task', 'activity', ?, ?, ?, ?)`,
      [linkId, params.id, activityId, refLabel, ts, user.id]),
    auditStmt(env.DB, {
      entityType: 'activity',
      entityId: activityId,
      eventType: 'created',
      user,
      summary: `Created task from AI Inbox: ${subject}`,
    }),
  ]);

  return json({
    ok: true,
    activity_id: activityId,
    link: {
      id: linkId,
      action_type: 'create_task',
      ref_type: 'activity',
      ref_id: activityId,
      ref_label: refLabel,
      created_at: ts,
    },
  });
}
