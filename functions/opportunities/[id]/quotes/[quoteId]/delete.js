// POST /opportunities/:id/quotes/:quoteId/delete
//
// Remove a quote. Terminal statuses (accepted / rejected / superseded
// / expired) are immutable — you cannot delete them — because they
// represent historical facts we want to preserve. Draft / internal /
// submitted quotes can be deleted; ON DELETE CASCADE on quote_lines
// cleans up the child rows.

import { one, stmt, batch } from '../../../../lib/db.js';
import { auditStmt } from '../../../../lib/audit.js';
import { redirectWithFlash } from '../../../../lib/http.js';

const LOCKED_FOR_DELETE = new Set([
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

  const quote = await one(
    env.DB,
    'SELECT id, number, revision, status, opportunity_id FROM quotes WHERE id = ?',
    [quoteId]
  );
  if (!quote || quote.opportunity_id !== oppId) {
    return new Response('Quote not found', { status: 404 });
  }
  if (LOCKED_FOR_DELETE.has(quote.status)) {
    return redirectWithFlash(
      `/opportunities/${oppId}/quotes/${quoteId}`,
      `Cannot delete a ${quote.status} quote — create a new revision instead.`,
      'error'
    );
  }

  await batch(env.DB, [
    stmt(env.DB, 'DELETE FROM quotes WHERE id = ?', [quoteId]),
    auditStmt(env.DB, {
      entityType: 'quote',
      entityId: quoteId,
      eventType: 'deleted',
      user,
      summary: `Deleted ${quote.number} Rev ${quote.revision}`,
    }),
  ]);

  return redirectWithFlash(
    `/opportunities/${oppId}?tab=quotes`,
    `Deleted ${quote.number} Rev ${quote.revision}.`
  );
}
