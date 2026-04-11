// functions/opportunities/[id]/cost-builds/[buildId]/unlock.js
//
// POST /opportunities/:id/cost-builds/:buildId/unlock — return a
// locked cost build to draft status so it can be edited again.

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
  if (cb.status !== 'locked') {
    return redirectWithFlash(
      `/opportunities/${oppId}/cost-builds/${buildId}`,
      'Already unlocked.',
      'info'
    );
  }

  const ts = now();

  await batch(env.DB, [
    stmt(
      env.DB,
      `UPDATE cost_builds
          SET status = 'draft',
              locked_at = NULL,
              locked_by_user_id = NULL,
              updated_at = ?
        WHERE id = ?`,
      [ts, buildId]
    ),
    auditStmt(env.DB, {
      entityType: 'cost_build',
      entityId: buildId,
      eventType: 'unlocked',
      user,
      summary: `Unlocked ${cb.label || 'cost build'}`,
    }),
  ]);

  return redirectWithFlash(
    `/opportunities/${oppId}/cost-builds/${buildId}`,
    'Unlocked.'
  );
}
