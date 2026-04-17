// functions/quotes/[id]/delete.js
//
// POST /quotes/:id/delete
//
// Sibling of POST /opportunities/:oppId/quotes/:quoteId/delete —
// same policy, same audit trail, but keyed only by quote id so the
// bulk-edit driver on /quotes can target it as `/quotes/:id/delete`
// (the driver only supports a single `:id` placeholder).
//
// Draft / revision_draft quotes only. All customer-facing / terminal
// statuses are locked for history and refuse with 409.

import { one, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { redirectWithFlash, formBody } from '../../lib/http.js';

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
  const quoteId = params.id;

  const input = await formBody(request).catch(() => ({}));
  const ajax = isAjaxRequest(request, input);

  const quote = await one(
    env.DB,
    'SELECT id, number, revision, status, opportunity_id FROM quotes WHERE id = ?',
    [quoteId]
  );
  if (!quote) {
    if (ajax) return jsonResponse({ ok: false, error: 'Quote not found.' }, 404);
    return new Response('Quote not found', { status: 404 });
  }
  if (LOCKED_FOR_DELETE.has(quote.status)) {
    const msg = `Cannot delete ${quote.number} \u2014 it's ${quote.status}. Customer-facing / terminal quotes are preserved for history.`;
    if (ajax) return jsonResponse({ ok: false, error: msg }, 409);
    return redirectWithFlash('/quotes', msg, 'error');
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

  if (ajax) {
    return jsonResponse({ ok: true, id: quoteId });
  }
  return redirectWithFlash(
    '/quotes',
    `Deleted ${quote.number} Rev ${quote.revision}.`
  );
}
