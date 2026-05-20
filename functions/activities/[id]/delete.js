// functions/activities/[id]/delete.js
//
// POST /activities/:id/delete — Soft-delete an activity.
//
// R2 blobs for linked documents are left in place on soft delete
// (only purged on hard-delete or future expiry sweep). Linked documents
// are cascade-soft-deleted so they share the same deleted_at timestamp.

import { one, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { softDeleteStmt, softDeleteChildrenStmt } from '../../lib/soft-delete.js';
import { now } from '../../lib/ids.js';
import { formBody, redirectWithFlash } from '../../lib/http.js';

function wantsJson(request) {
  const a = request.headers.get('accept') || '';
  return a.includes('application/json') && !a.includes('text/html');
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const actId = params.id;
  const json = wantsJson(request);

  const act = await one(env.DB, 'SELECT * FROM activities WHERE id = ? AND deleted_at IS NULL', [actId]);
  if (!act) {
    if (json) return jsonResponse({ ok: false, error: 'Activity not found' }, 404);
    return new Response('Not found', { status: 404 });
  }

  // formBody is unavailable for JSON-mode bulk callers (no form body).
  // Skip return_to in JSON mode — bulk caller will reload after the loop.
  const input = json ? {} : await formBody(request);
  const returnTo = input.return_to || '/activities';

  const label = act.type === 'note'
    ? 'Note'
    : (act.subject || act.type);

  const ts = now();
  await batch(env.DB, [
    auditStmt(env.DB, {
      entityType: 'activity',
      entityId: actId,
      eventType: 'deleted',
      user,
      summary: `Deleted ${act.type}${act.subject ? ': ' + act.subject : ''}`,
    }),
    softDeleteChildrenStmt(env.DB, 'documents', 'activity_id', actId, ts),
    softDeleteStmt(env.DB, 'activities', actId, ts),
  ]);

  if (json) return jsonResponse({ ok: true, id: actId });
  return redirectWithFlash(returnTo, `Deleted ${label}.`, 'success', { undo: `/activities/${actId}/restore` });
}
