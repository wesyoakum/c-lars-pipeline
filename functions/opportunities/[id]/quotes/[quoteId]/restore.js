// POST /opportunities/:id/quotes/:quoteId/restore
//
// Undo a soft-deleted quote. Also restores child quote_lines that
// were cascade-soft-deleted at the same timestamp.

import { one, batch } from '../../../../lib/db.js';
import { auditStmt } from '../../../../lib/audit.js';
import { restoreStmt, restoreChildrenStmt } from '../../../../lib/soft-delete.js';
import { redirectWithFlash } from '../../../../lib/http.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const oppId = params.id;
  const quoteId = params.quoteId;

  const quote = await one(
    env.DB,
    `SELECT id, number, revision, opportunity_id, deleted_at FROM quotes WHERE id = ? AND deleted_at IS NOT NULL`,
    [quoteId]
  );
  if (!quote || quote.opportunity_id !== oppId) {
    return redirectWithFlash(`/opportunities/${oppId}?tab=quotes`, 'Quote not found or not deleted.', 'error');
  }

  await batch(env.DB, [
    restoreChildrenStmt(env.DB, 'quote_lines', 'quote_id', quoteId, quote.deleted_at),
    restoreStmt(env.DB, 'quotes', quoteId),
    auditStmt(env.DB, {
      entityType: 'quote',
      entityId: quoteId,
      eventType: 'restored',
      user,
      summary: `Restored ${quote.number} Rev ${quote.revision}`,
    }),
  ]);

  return redirectWithFlash(
    `/opportunities/${oppId}/quotes/${quoteId}`,
    `Restored ${quote.number} Rev ${quote.revision}.`
  );
}
