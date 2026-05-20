// functions/activities/[id]/restore.js
//
// POST /activities/:id/restore — undo a soft-deleted activity.
// Also restores any documents that were cascade-soft-deleted at the same timestamp.

import { one, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { restoreStmt, restoreChildrenStmt } from '../../lib/soft-delete.js';
import { redirectWithFlash } from '../../lib/http.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const actId = params.id;

  const act = await one(
    env.DB,
    `SELECT id, type, subject, deleted_at FROM activities WHERE id = ? AND deleted_at IS NOT NULL`,
    [actId]
  );
  if (!act) {
    return redirectWithFlash('/activities', 'Activity not found or not deleted.', 'error');
  }

  const label = act.type === 'note'
    ? 'Note'
    : (act.subject || act.type);

  await batch(env.DB, [
    restoreChildrenStmt(env.DB, 'documents', 'activity_id', actId, act.deleted_at),
    restoreStmt(env.DB, 'activities', actId),
    auditStmt(env.DB, {
      entityType: 'activity',
      entityId: actId,
      eventType: 'restored',
      user,
      summary: `Restored ${act.type}${act.subject ? ': ' + act.subject : ''}`,
    }),
  ]);

  return redirectWithFlash('/activities', `Restored ${label}.`);
}
