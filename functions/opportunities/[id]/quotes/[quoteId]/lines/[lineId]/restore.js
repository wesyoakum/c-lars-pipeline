// functions/opportunities/[id]/quotes/[quoteId]/lines/[lineId]/restore.js
//
// POST /opportunities/:id/quotes/:quoteId/lines/:lineId/restore
// Undo a soft-deleted quote line and recompute quote totals.

import { one, batch } from '../../../../../../lib/db.js';
import { auditStmt } from '../../../../../../lib/audit.js';
import { restoreStmt } from '../../../../../../lib/soft-delete.js';
import { now } from '../../../../../../lib/ids.js';
import { redirectWithFlash } from '../../../../../../lib/http.js';
import { quoteTotalsRecomputeStmt } from '../../../../../../lib/pricing.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const oppId = params.id;
  const quoteId = params.quoteId;
  const lineId = params.lineId;

  const line = await one(
    env.DB,
    `SELECT id, description, quote_id FROM quote_lines WHERE id = ? AND deleted_at IS NOT NULL`,
    [lineId]
  );
  if (!line || line.quote_id !== quoteId) {
    return redirectWithFlash(
      `/opportunities/${oppId}/quotes/${quoteId}`,
      'Line not found or not deleted.',
      'error'
    );
  }

  const ts = now();
  await batch(env.DB, [
    restoreStmt(env.DB, 'quote_lines', lineId),
    quoteTotalsRecomputeStmt(env.DB, quoteId, ts),
    auditStmt(env.DB, {
      entityType: 'quote_line',
      entityId: lineId,
      eventType: 'restored',
      user,
      summary: `Restored line: ${line.description}`,
    }),
  ]);

  return redirectWithFlash(
    `/opportunities/${oppId}/quotes/${quoteId}`,
    'Line restored.'
  );
}
