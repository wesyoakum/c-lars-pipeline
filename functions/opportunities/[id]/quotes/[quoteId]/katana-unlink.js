// functions/opportunities/[id]/quotes/[quoteId]/katana-unlink.js
//
// POST /opportunities/:id/quotes/:quoteId/katana-unlink
//
// Clears quotes.katana_sales_order_id + katana_sales_order_pushed_at
// without touching Katana. Pipeline simply forgets which Katana sales
// order it pushed; the SO in Katana is left alone (still useful for
// historical billing). The "Push to Katana" button reappears so the
// user can push again (e.g. if they accidentally deleted the SO in
// Katana directly).

import { one, batch, stmt } from '../../../../lib/db.js';
import { auditStmt } from '../../../../lib/audit.js';
import { hasRole } from '../../../../lib/auth.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  if (!user) return jsonError(401, 'sign-in required');
  if (!hasRole(user, 'admin')) return jsonError(403, 'admin only');

  const oppId = params.id;
  const quoteId = params.quoteId;

  const existing = await one(env.DB,
    `SELECT id, number, katana_sales_order_id, katana_sales_order_pushed_at
       FROM quotes
      WHERE id = ? AND opportunity_id = ?`,
    [quoteId, oppId]);
  if (!existing) return jsonError(404, 'quote not found');

  if (!existing.katana_sales_order_id) {
    // Already unlinked — return success so the UI stays consistent.
    return jsonOk({ quote_id: quoteId });
  }

  const oldId = existing.katana_sales_order_id;
  const oldAt = existing.katana_sales_order_pushed_at;

  await batch(env.DB, [
    stmt(env.DB,
      `UPDATE quotes
          SET katana_sales_order_id        = NULL,
              katana_sales_order_pushed_at = NULL,
              updated_at                   = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
      [quoteId]),
    auditStmt(env.DB, {
      entityType: 'quote',
      entityId: quoteId,
      eventType: 'updated',
      user,
      summary: `Unlinked Katana sales order #${oldId} (Katana record left in place)`,
      changes: {
        katana_sales_order_id:        { from: oldId, to: null },
        katana_sales_order_pushed_at: { from: oldAt, to: null },
      },
    }),
  ]);

  return jsonOk({ quote_id: quoteId });
}

function jsonOk(obj) {
  return new Response(JSON.stringify({ ok: true, ...obj }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
function jsonError(status, message) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
