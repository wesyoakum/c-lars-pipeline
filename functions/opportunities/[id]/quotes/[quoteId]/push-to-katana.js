// functions/opportunities/[id]/quotes/[quoteId]/push-to-katana.js
//
// POST /opportunities/:id/quotes/:quoteId/push-to-katana
//
// Phase 2c. Creates a Katana sales order from a Pipeline quote.
//
// Body (JSON):
//   {
//     order_no:      string,                 // default = quote.number
//     customer_ref:  string,                 // optional, free text
//     delivery_date: string ('YYYY-MM-DD'),  // optional, ISO date
//     additional_info: string,               // optional, free text
//     milestones: [                          // edited per-row $$ from the modal
//       { percent, label, katana_variant_id, amount },
//       ...
//     ]
//   }
//
// All milestones-array fields except `amount` are advisory — the
// server re-validates against the saved milestone map and re-derives
// percent/label/variant_id from there. `amount` is the only thing the
// client controls, and only because the user might want to nudge a
// milestone $ up or down. The amounts must sum to quote.total_price
// (within 0.01 tolerance).
//
// Validations (in order):
//   1. account_id of opp has katana_customer_id set
//   2. quote.total_price > 0
//   3. quote.katana_sales_order_id IS NULL (idempotency)
//   4. site_prefs.katana_milestone_map is set
//   5. body.milestones length matches the saved map length
//   6. body.milestones amounts sum to quote.total_price
//
// On success: stores the new Katana sales-order id on the quote row
// + audit log entry. Returns { ok, katana_sales_order_id, order_no }.

import { one, batch, stmt } from '../../../../lib/db.js';
import { auditStmt } from '../../../../lib/audit.js';
import { hasRole } from '../../../../lib/auth.js';
import { apiPost } from '../../../../lib/katana-client.js';
import { loadMilestoneMap } from '../../../../lib/katana-milestones.js';

// Hardcoded for v1. Both confirmed via the Katana probe (single
// location, single "No tax" rate). When Adam's tenant grows multi-
// location or multi-tax-rate we'll surface these as defaults on the
// /settings/katana-milestones page.
const DEFAULT_LOCATION_ID = 182262;
const DEFAULT_TAX_RATE_ID = 475753;

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  if (!user) return jsonError(401, 'sign-in required');
  if (!hasRole(user, 'admin')) return jsonError(403, 'admin only');

  const oppId = params.id;
  const quoteId = params.quoteId;

  let body;
  try { body = await request.json(); }
  catch { return jsonError(400, 'invalid JSON body'); }

  // 1. Load quote + opp + account in one shot.
  const ctx = await one(env.DB,
    `SELECT q.id AS quote_id, q.number AS quote_number, q.total_price,
            q.status AS quote_status,
            q.katana_sales_order_id, q.katana_sales_order_pushed_at,
            q.opportunity_id,
            o.account_id,
            a.name AS account_name,
            a.katana_customer_id, a.katana_customer_name
       FROM quotes q
       LEFT JOIN opportunities o ON o.id = q.opportunity_id
       LEFT JOIN accounts a      ON a.id = o.account_id
      WHERE q.id = ? AND q.opportunity_id = ?`,
    [quoteId, oppId]);

  if (!ctx) return jsonError(404, 'quote not found');
  if (ctx.katana_sales_order_id) {
    return jsonError(409, `already pushed (Katana SO #${ctx.katana_sales_order_id} on ${ctx.katana_sales_order_pushed_at}). Unlink first if you want to re-push.`);
  }
  if (!ctx.katana_customer_id) {
    return jsonError(400, `account "${ctx.account_name}" has no Katana customer mapping. Set it at /settings/katana-customer-map first.`);
  }
  const total = Number(ctx.total_price);
  if (!Number.isFinite(total) || total <= 0) {
    return jsonError(400, `quote total ($${total}) must be greater than zero`);
  }

  // 2. Load + validate milestone map.
  const map = await loadMilestoneMap(env);
  if (!map || !Array.isArray(map.milestones) || map.milestones.length === 0) {
    return jsonError(400, 'Katana milestone map is not configured. Set it at /settings/katana-milestones first.');
  }

  // 3. Cross-check the body's amounts.
  const submitted = Array.isArray(body?.milestones) ? body.milestones : [];
  if (submitted.length !== map.milestones.length) {
    return jsonError(400, `expected ${map.milestones.length} milestone amounts, got ${submitted.length}`);
  }
  let sum = 0;
  const rowsToBuild = [];
  for (let i = 0; i < map.milestones.length; i++) {
    const m = map.milestones[i];
    const a = Number(submitted[i]?.amount);
    if (!Number.isFinite(a) || a < 0) {
      return jsonError(400, `milestone ${i + 1} (${m.label}): amount must be a non-negative number`);
    }
    sum += a;
    rowsToBuild.push({
      variant_id:   m.katana_variant_id,
      quantity:     1,
      price_per_unit: a,
      tax_rate_id:  DEFAULT_TAX_RATE_ID,
    });
  }
  // Allow 1-cent rounding tolerance for the user-edited amounts.
  if (Math.abs(sum - total) > 0.01) {
    return jsonError(400, `milestone amounts ($${sum.toFixed(2)}) must sum to quote total ($${total.toFixed(2)})`);
  }

  // 4. Build the sales-order body.
  const orderNo = String(body?.order_no || ctx.quote_number || '').trim().slice(0, 80);
  if (!orderNo) return jsonError(400, 'order_no is required');

  const katanaBody = {
    order_no: orderNo,
    customer_id: ctx.katana_customer_id,
    location_id: DEFAULT_LOCATION_ID,
    sales_order_rows: rowsToBuild,
  };
  const customerRef = String(body?.customer_ref || '').trim();
  if (customerRef) katanaBody.customer_ref = customerRef.slice(0, 200);
  const deliveryDate = String(body?.delivery_date || '').trim();
  if (deliveryDate) {
    // Accept YYYY-MM-DD; turn into ISO with end-of-day so Katana
    // doesn't interpret midnight UTC as the previous day.
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(deliveryDate);
    if (m) katanaBody.delivery_date = `${deliveryDate}T17:00:00.000Z`;
    else   katanaBody.delivery_date = deliveryDate;
  }
  const addInfo = String(body?.additional_info || '').trim();
  if (addInfo) katanaBody.additional_info = addInfo.slice(0, 2000);

  // 5. Push.
  let created;
  try {
    const r = await apiPost(env, '/sales_orders', katanaBody);
    if (!r.ok) {
      return jsonError(502, `Katana rejected sales-order create: ${r.status} ${typeof r.body === 'string' ? r.body.slice(0, 400) : JSON.stringify(r.body).slice(0, 400)}`);
    }
    created = r.body;
  } catch (err) {
    return jsonError(502, `Katana sales-order create failed: ${String(err && err.message || err)}`);
  }
  const newId = parseInt(created?.id, 10);
  if (!Number.isFinite(newId) || newId <= 0) {
    return jsonError(502, `Katana create returned no usable id (got ${JSON.stringify(created).slice(0, 200)})`);
  }

  // 6. Persist + audit.
  const nowIso = new Date().toISOString();
  await batch(env.DB, [
    stmt(env.DB,
      `UPDATE quotes
          SET katana_sales_order_id        = ?,
              katana_sales_order_pushed_at = ?,
              updated_at                   = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
      [newId, nowIso, quoteId]),
    auditStmt(env.DB, {
      entityType: 'quote',
      entityId: quoteId,
      eventType: 'updated',
      user,
      summary: `Pushed to Katana as sales order "${orderNo}" (#${newId}, $${total.toFixed(2)})`,
      changes: {
        katana_sales_order_id:        { from: null, to: newId },
        katana_sales_order_pushed_at: { from: null, to: nowIso },
      },
    }),
  ]);

  return jsonOk({
    katana_sales_order_id: newId,
    katana_sales_order_pushed_at: nowIso,
    order_no: orderNo,
  });
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
