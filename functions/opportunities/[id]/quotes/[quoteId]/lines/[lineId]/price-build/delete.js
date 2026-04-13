// POST /opportunities/:id/quotes/:quoteId/lines/:lineId/price-build/delete

import { one, stmt, batch } from '../../../../../../lib/db.js';
import { auditStmt } from '../../../../../../lib/audit.js';
import { now } from '../../../../../../lib/ids.js';
import { redirectWithFlash } from '../../../../../../lib/http.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const { id: oppId, quoteId, lineId } = params;

  const cb = await one(
    env.DB,
    `SELECT cb.id, cb.label, cb.status
       FROM cost_builds cb
       JOIN quote_lines ql ON ql.id = cb.quote_line_id
       JOIN quotes q ON q.id = ql.quote_id
      WHERE cb.quote_line_id = ? AND q.id = ? AND q.opportunity_id = ?`,
    [lineId, quoteId, oppId]
  );
  if (!cb) return new Response('Price build not found', { status: 404 });
  if (cb.status === 'locked') {
    return new Response('Unlock the price build before deleting.', { status: 409 });
  }

  const ts = now();
  await batch(env.DB, [
    // Clear the FK on the line item
    stmt(env.DB, 'UPDATE quote_lines SET cost_build_id = NULL, updated_at = ? WHERE id = ?', [ts, lineId]),
    // Delete the build (cascades to selections/labor)
    stmt(env.DB, 'DELETE FROM cost_builds WHERE id = ?', [cb.id]),
    auditStmt(env.DB, {
      entityType: 'cost_build', entityId: cb.id, eventType: 'deleted', user,
      summary: `Deleted price build ${cb.label || ''}`,
    }),
  ]);

  return redirectWithFlash(
    `/opportunities/${oppId}/quotes/${quoteId}`,
    `Deleted price build.`
  );
}
