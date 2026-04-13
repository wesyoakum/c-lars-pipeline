// functions/activities/[id]/delete.js
//
// POST /activities/:id/delete — Delete an activity.

import { one, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { redirectWithFlash } from '../../lib/http.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const actId = params.id;

  const act = await one(env.DB, 'SELECT * FROM activities WHERE id = ?', [actId]);
  if (!act) return new Response('Not found', { status: 404 });

  await batch(env.DB, [
    stmt(env.DB, 'DELETE FROM activities WHERE id = ?', [actId]),
    auditStmt(env.DB, {
      entityType: 'activity',
      entityId: actId,
      eventType: 'deleted',
      user,
      summary: `Deleted ${act.type}: ${act.subject}`,
    }),
  ]);

  return redirectWithFlash('/activities', `Deleted: ${act.subject}`);
}
