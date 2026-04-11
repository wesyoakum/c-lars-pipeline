// functions/opportunities/[id]/cost-builds/[buildId]/lock.js
//
// POST /opportunities/:id/cost-builds/:buildId/lock — freeze a cost
// build as read-only. Locked builds still render on the detail page
// but every input is disabled and the Save button is hidden. Unlock
// to resume editing (POST /unlock).

import { one, stmt, batch } from '../../../../lib/db.js';
import { auditStmt } from '../../../../lib/audit.js';
import { now } from '../../../../lib/ids.js';
import { redirectWithFlash } from '../../../../lib/http.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const oppId = params.id;
  const buildId = params.buildId;

  const cb = await one(
    env.DB,
    'SELECT id, label, status, opportunity_id FROM cost_builds WHERE id = ?',
    [buildId]
  );
  if (!cb || cb.opportunity_id !== oppId) {
    return new Response('Cost build not found', { status: 404 });
  }
  if (cb.status === 'locked') {
    return redirectWithFlash(
      `/opportunities/${oppId}/cost-builds/${buildId}`,
      'Already locked.',
      'info'
    );
  }

  const ts = now();

  await batch(env.DB, [
    stmt(
      env.DB,
      `UPDATE cost_builds
          SET status = 'locked',
              locked_at = ?,
              locked_by_user_id = ?,
              updated_at = ?
        WHERE id = ?`,
      [ts, user?.id ?? null, ts, buildId]
    ),
    auditStmt(env.DB, {
      entityType: 'cost_build',
      entityId: buildId,
      eventType: 'locked',
      user,
      summary: `Locked ${cb.label || 'cost build'}`,
    }),
  ]);

  return redirectWithFlash(
    `/opportunities/${oppId}/cost-builds/${buildId}`,
    'Locked.'
  );
}
