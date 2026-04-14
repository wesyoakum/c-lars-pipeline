// functions/opportunities/[id]/cost-builds/[buildId]/delete.js
//
// POST /opportunities/:id/cost-builds/:buildId/delete — remove a cost
// build. ON DELETE CASCADE on cost_build_dm_selections /
// cost_build_labor_selections / cost_build_labor cleans up the child
// rows automatically.

import { one, stmt, batch } from '../../../../lib/db.js';
import { auditStmt } from '../../../../lib/audit.js';
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
    return new Response('Price build not found', { status: 404 });
  }
  if (cb.status === 'locked') {
    return new Response('Unlock the price build before deleting.', { status: 409 });
  }

  await batch(env.DB, [
    stmt(env.DB, 'DELETE FROM cost_builds WHERE id = ?', [buildId]),
    auditStmt(env.DB, {
      entityType: 'cost_build',
      entityId: buildId,
      eventType: 'deleted',
      user,
      summary: `Deleted ${cb.label || 'price build'}`,
    }),
  ]);

  return redirectWithFlash(
    `/opportunities/${oppId}?tab=cost`,
    `Deleted ${cb.label || 'price build'}.`
  );
}
