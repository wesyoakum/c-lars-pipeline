// POST /opportunities/:id/quotes/:quoteId/delete
//
// Soft-delete a quote. Terminal / customer-facing statuses are locked —
// they represent historical facts. Only draft revisions can be removed.
// Child quote_lines are cascade-soft-deleted at the same timestamp.

import { one, batch } from '../../../../lib/db.js';
import { auditStmt } from '../../../../lib/audit.js';
import { softDeleteStmt, softDeleteChildrenStmt } from '../../../../lib/soft-delete.js';
import { now } from '../../../../lib/ids.js';
import { redirectWithFlash, formBody } from '../../../../lib/http.js';

// Quote statuses we refuse to delete.
const LOCKED_FOR_DELETE = new Set([
  'issued',
  'revision_issued',
  'accepted',
  'rejected',
  'expired',
  'dead',
  'completed',
]);

function isAjaxRequest(request, input) {
  if (input?.source === 'wizard' || input?.source === 'modal' || input?.source === 'bulk') return true;
  const xrw = request.headers.get('x-requested-with');
  if (xrw && xrw.toLowerCase() === 'xmlhttprequest') return true;
  const accept = request.headers.get('accept') || '';
  return accept.includes('application/json') && !accept.includes('text/html');
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const oppId = params.id;
  const quoteId = params.quoteId;

  const input = await formBody(request).catch(() => ({}));
  const ajax = isAjaxRequest(request, input);

  const quote = await one(
    env.DB,
    'SELECT id, number, revision, status, opportunity_id FROM quotes WHERE id = ? AND deleted_at IS NULL',
    [quoteId]
  );
  if (!quote || quote.opportunity_id !== oppId) {
    if (ajax) return jsonResponse({ ok: false, error: 'Quote not found.' }, 404);
    return new Response('Quote not found', { status: 404 });
  }
  if (LOCKED_FOR_DELETE.has(quote.status)) {
    const msg = `Cannot delete a ${quote.status} quote \u2014 customer-facing / terminal quotes are preserved for history. Revise or re-issue instead.`;
    if (ajax) return jsonResponse({ ok: false, error: msg }, 409);
    return redirectWithFlash(
      `/opportunities/${oppId}/quotes/${quoteId}`,
      msg,
      'error'
    );
  }

  const ts = now();
  await batch(env.DB, [
    auditStmt(env.DB, {
      entityType: 'quote',
      entityId: quoteId,
      eventType: 'deleted',
      user,
      summary: `Deleted ${quote.number} Rev ${quote.revision}`,
    }),
    softDeleteChildrenStmt(env.DB, 'quote_lines', 'quote_id', quoteId, ts),
    softDeleteStmt(env.DB, 'quotes', quoteId, ts),
  ]);

  if (ajax) {
    return jsonResponse({ ok: true, id: quoteId });
  }
  return redirectWithFlash(
    `/opportunities/${oppId}?tab=quotes`,
    `Deleted ${quote.number} Rev ${quote.revision}.`,
    'success',
    { undo: `/opportunities/${oppId}/quotes/${quoteId}/restore` }
  );
}
