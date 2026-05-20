// functions/opportunities/[id]/cost-builds/[buildId]/restore.js
//
// POST /opportunities/:id/cost-builds/:buildId/restore — undo a
// soft-deleted cost build. Junction tables (dm_selections, labor_selections,
// labor) don't have deleted_at — they stay in place and are available
// immediately when the parent cost_build is restored.

import { one, batch } from '../../../../lib/db.js';
import { auditStmt } from '../../../../lib/audit.js';
import { restoreStmt } from '../../../../lib/soft-delete.js';
import { redirectWithFlash } from '../../../../lib/http.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const oppId = params.id;
  const buildId = params.buildId;

  const cb = await one(
    env.DB,
    `SELECT id, label, opportunity_id, deleted_at FROM cost_builds WHERE id = ? AND deleted_at IS NOT NULL`,
    [buildId]
  );
  if (!cb || cb.opportunity_id !== oppId) {
    return redirectWithFlash(`/opportunities/${oppId}?tab=cost`, 'Price build not found or not deleted.', 'error');
  }

  await batch(env.DB, [
    restoreStmt(env.DB, 'cost_builds', buildId),
    auditStmt(env.DB, {
      entityType: 'cost_build',
      entityId: buildId,
      eventType: 'restored',
      user,
      summary: `Restored ${cb.label || 'price build'}`,
    }),
  ]);

  return redirectWithFlash(
    `/opportunities/${oppId}?tab=cost`,
    `Restored ${cb.label || 'price build'}.`
  );
}
