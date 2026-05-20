// functions/opportunities/[id]/quotes/[quoteId]/katana-unlink.js
//
// POST /opportunities/:id/quotes/:quoteId/katana-unlink
//
// Clears the per-line Katana sales-order linkage on every quote line
// for this quote, without touching Katana. Pipeline forgets which
// Katana SOs it pushed; the SOs themselves stay in place (useful for
// historical billing). The "Push to Katana" button reappears and
// only the unlinked lines are pushed again on the next click —
// idempotent.
//
// Also clears the legacy quotes.katana_sales_order_id column (from
// Phase 2c, single-SO model) for forward compatibility.

import { all, batch, stmt, run } from '../../../../lib/db.js';
import { auditStmt } from '../../../../lib/audit.js';
import { hasRole } from '../../../../lib/auth.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  if (!user) return jsonError(401, 'sign-in required');
  if (!hasRole(user, 'admin')) return jsonError(403, 'admin only');

  const oppId = params.id;
  const quoteId = params.quoteId;

  // Find every line that has a Katana linkage to clear.
  const linkedLines = await all(env.DB,
    `SELECT ql.id, ql.title, ql.katana_sales_order_id, ql.katana_sales_order_pushed_at
       FROM quote_lines ql
       JOIN quotes q ON q.id = ql.quote_id
      WHERE ql.quote_id = ?
        AND q.opportunity_id = ?
        AND ql.katana_sales_order_id IS NOT NULL`,
    [quoteId, oppId]);

  // If nothing linked at line level, still clear the legacy quote-level
  // column (if set) so the UI is consistent regardless of which push
  // model created the link.
  if (linkedLines.length === 0) {
    await run(env.DB,
      `UPDATE quotes
          SET katana_sales_order_id        = NULL,
              katana_sales_order_pushed_at = NULL,
              updated_at                   = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND opportunity_id = ?`,
      [quoteId, oppId]);
    return jsonOk({ quote_id: quoteId, unlinked_count: 0 });
  }

  const statements = [];
  for (const ln of linkedLines) {
    statements.push(stmt(env.DB,
      `UPDATE quote_lines
          SET katana_sales_order_id        = NULL,
              katana_sales_order_pushed_at = NULL,
              katana_push_error            = NULL,
              updated_at                   = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
      [ln.id]));
    statements.push(auditStmt(env.DB, {
      entityType: 'quote_line',
      entityId:   ln.id,
      eventType:  'updated',
      user,
      summary:    `Unlinked Katana sales order #${ln.katana_sales_order_id} from line "${ln.title || ln.id}" (Katana record left in place)`,
      changes: {
        katana_sales_order_id: { from: ln.katana_sales_order_id, to: null },
      },
    }));
  }
  // Also clear the legacy quote-level column for consistency.
  statements.push(stmt(env.DB,
    `UPDATE quotes
        SET katana_sales_order_id        = NULL,
            katana_sales_order_pushed_at = NULL,
            updated_at                   = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
    [quoteId]));

  await batch(env.DB, statements);

  return jsonOk({ quote_id: quoteId, unlinked_count: linkedLines.length });
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
