// functions/opportunities/[id]/cost-builds/[buildId]/delete.js
//
// POST /opportunities/:id/cost-builds/:buildId/delete — Soft-delete a
// cost build. Child junction tables (cost_build_dm_selections /
// cost_build_labor_selections / cost_build_labor) stay in place — they
// don't have deleted_at and are preserved so restore works cleanly.

import { one, batch } from '../../../../lib/db.js';
import { auditStmt } from '../../../../lib/audit.js';
import { softDeleteStmt } from '../../../../lib/soft-delete.js';
import { now } from '../../../../lib/ids.js';
import { redirectWithFlash } from '../../../../lib/http.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const oppId = params.id;
  const buildId = params.buildId;

  const cb = await one(
    env.DB,
    'SELECT id, label, status, opportunity_id FROM cost_builds WHERE id = ? AND deleted_at IS NULL',
    [buildId]
  );
  if (!cb || cb.opportunity_id !== oppId) {
    return new Response('Price build not found', { status: 404 });
  }
  if (cb.status === 'locked') {
    return new Response('Unlock the price build before deleting.', { status: 409 });
  }

  const ts = now();
  await batch(env.DB, [
    auditStmt(env.DB, {
      entityType: 'cost_build',
      entityId: buildId,
      eventType: 'deleted',
      user,
      summary: `Deleted ${cb.label || 'price build'}`,
    }),
    softDeleteStmt(env.DB, 'cost_builds', buildId, ts),
  ]);

  return redirectWithFlash(
    `/opportunities/${oppId}?tab=cost`,
    `Deleted ${cb.label || 'price build'}.`,
    'success',
    { undo: `/opportunities/${oppId}/cost-builds/${buildId}/restore` }
  );
}
