// functions/activities/[id]/complete.js
//
// POST /activities/:id/complete — Mark an activity as completed.

import { one, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { now } from '../../lib/ids.js';
import { redirectWithFlash } from '../../lib/http.js';

export async function onRequestPost(context) {
  const { env, data, params, request } = context;
  const user = data?.user;
  const actId = params.id;

  const act = await one(env.DB, 'SELECT * FROM activities WHERE id = ?', [actId]);
  if (!act) return new Response('Not found', { status: 404 });

  const ts = now();

  await batch(env.DB, [
    stmt(env.DB,
      `UPDATE activities SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`,
      [ts, ts, actId]),
    auditStmt(env.DB, {
      entityType: 'activity',
      entityId: actId,
      eventType: 'completed',
      user,
      summary: `Completed ${act.type}: ${act.subject}`,
    }),
  ]);

  // Redirect back to referrer if available, otherwise activities list
  const referer = request.headers.get('referer');
  if (referer) {
    try {
      const refUrl = new URL(referer);
      return redirectWithFlash(refUrl.pathname, `Completed: ${act.subject}`);
    } catch {}
  }

  return redirectWithFlash('/activities', `Completed: ${act.subject}`);
}
