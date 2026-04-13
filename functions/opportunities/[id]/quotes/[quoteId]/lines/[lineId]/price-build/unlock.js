// POST /opportunities/:id/quotes/:quoteId/lines/:lineId/price-build/unlock

import { one, stmt, batch } from '../../../../../../../lib/db.js';
import { auditStmt } from '../../../../../../../lib/audit.js';
import { now } from '../../../../../../../lib/ids.js';
import { redirectWithFlash } from '../../../../../../../lib/http.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const { id: oppId, quoteId, lineId } = params;
  const base = `/opportunities/${oppId}/quotes/${quoteId}/lines/${lineId}/price-build`;

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
  if (cb.status !== 'locked') {
    return redirectWithFlash(base, 'Already unlocked.', 'info');
  }

  const ts = now();
  await batch(env.DB, [
    stmt(env.DB,
      `UPDATE cost_builds SET status = 'draft', locked_at = NULL, locked_by_user_id = NULL, updated_at = ? WHERE id = ?`,
      [ts, cb.id]
    ),
    auditStmt(env.DB, {
      entityType: 'cost_build', entityId: cb.id, eventType: 'unlocked', user,
      summary: `Unlocked price build ${cb.label || ''}`,
    }),
  ]);

  return redirectWithFlash(base, 'Unlocked.');
}
