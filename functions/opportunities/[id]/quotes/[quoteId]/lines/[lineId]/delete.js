// functions/opportunities/[id]/quotes/[quoteId]/lines/[lineId]/delete.js
//
// POST /opportunities/:id/quotes/:quoteId/lines/:lineId/delete
// Removes a line item and recomputes the quote totals.

import { one, stmt, batch } from '../../../../../../lib/db.js';
import { auditStmt } from '../../../../../../lib/audit.js';
import { now } from '../../../../../../lib/ids.js';
import { redirectWithFlash } from '../../../../../../lib/http.js';

const READ_ONLY_STATUSES = new Set([
  'accepted',
  'rejected',
  'superseded',
  'expired',
]);

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const oppId = params.id;
  const quoteId = params.quoteId;
  const lineId = params.lineId;

  const quote = await one(
    env.DB,
    'SELECT id, number, revision, status, opportunity_id FROM quotes WHERE id = ?',
    [quoteId]
  );
  if (!quote || quote.opportunity_id !== oppId) {
    return new Response('Quote not found', { status: 404 });
  }
  if (READ_ONLY_STATUSES.has(quote.status)) {
    return redirectWithFlash(
      `/opportunities/${oppId}/quotes/${quoteId}`,
      `Cannot delete lines on a ${quote.status} quote.`,
      'error'
    );
  }

  const line = await one(
    env.DB,
    'SELECT id, description FROM quote_lines WHERE id = ? AND quote_id = ?',
    [lineId, quoteId]
  );
  if (!line) {
    return new Response('Line not found', { status: 404 });
  }

  const ts = now();

  await batch(env.DB, [
    stmt(
      env.DB,
      'DELETE FROM quote_lines WHERE id = ? AND quote_id = ?',
      [lineId, quoteId]
    ),
    stmt(
      env.DB,
      `UPDATE quotes
          SET subtotal_price = (SELECT COALESCE(SUM(extended_price), 0) FROM quote_lines WHERE quote_id = ?),
              total_price    = (SELECT COALESCE(SUM(extended_price), 0) FROM quote_lines WHERE quote_id = ?) + COALESCE(tax_amount, 0),
              updated_at     = ?
        WHERE id = ?`,
      [quoteId, quoteId, ts, quoteId]
    ),
    auditStmt(env.DB, {
      entityType: 'quote_line',
      entityId: lineId,
      eventType: 'deleted',
      user,
      summary: `Deleted line from ${quote.number} Rev ${quote.revision}: ${line.description}`,
    }),
  ]);

  return redirectWithFlash(
    `/opportunities/${oppId}/quotes/${quoteId}`,
    'Line deleted.'
  );
}
