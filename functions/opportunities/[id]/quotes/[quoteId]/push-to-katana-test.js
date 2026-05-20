// functions/opportunities/[id]/quotes/[quoteId]/push-to-katana-test.js
//
// POST /opportunities/:id/quotes/:quoteId/push-to-katana-test
//
// Step 1 of the incremental rebuild — fires the most minimal valid
// Katana sales order possible. Goals:
//   1. Confirm the create-SO path works with our auth + customer-id
//      pairing on a real account's push path (not just the
//      customer-create that /settings/katana-customer-map exercises).
//   2. Return the FULL Katana response so we can see what fields are
//      auto-filled (delivery_date defaults, picked_date, total_in_
//      base_currency, etc.) before we commit to using them in Step 2.
//   3. Surface real error shapes from Katana for malformed bodies.
//   4. Be disposable — Pipeline writes NO state. User manually
//      inspects + deletes the resulting SO in Katana.
//
// What flows from Pipeline:
//   * customer_id from accounts.katana_customer_id
// What's placeholder:
//   * order_no = `TEST-<unix-ms>`
//   * One row with the first milestone variant from the saved map,
//     qty 1, price $0.01, default tax rate
//
// This route does NOT touch quotes.katana_sales_order_id and does NOT
// audit-log. The real push lives at push-to-katana.js (Phase 2c).

import { one } from '../../../../lib/db.js';
import { hasRole } from '../../../../lib/auth.js';
import { apiPost } from '../../../../lib/katana-client.js';
import { loadMilestoneMap } from '../../../../lib/katana-milestones.js';

// Default tax rate, confirmed via the Katana probe — single "No tax"
// rate on Adam's tenant. Step 6 will look this up properly.
const DEFAULT_TAX_RATE_ID = 475753;

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  if (!user) return jsonError(401, 'sign-in required');
  if (!hasRole(user, 'admin')) return jsonError(403, 'admin only');

  const oppId = params.id;
  const quoteId = params.quoteId;

  // Load just enough to identify the quote + its account.
  const ctx = await one(env.DB,
    `SELECT q.id AS quote_id, q.number AS quote_number,
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

  if (!ctx.katana_customer_id) {
    return jsonError(400,
      `account "${ctx.account_name}" has no Katana customer mapping. Link it at /settings/katana-customer-map first.`);
  }

  // Grab any milestone variant to put on the placeholder row. We
  // prefer the first entry from the saved map (the canonical "1st
  // milestone" variant); fall back nicely if the admin hasn't run
  // /settings/katana-milestones yet.
  const map = await loadMilestoneMap(env);
  const firstMilestone = map?.milestones?.[0];
  if (!firstMilestone || !firstMilestone.katana_variant_id) {
    return jsonError(400,
      'No milestone map configured (need at least one milestone with a Katana variant). Configure at /settings/katana-milestones.');
  }

  const body = {
    order_no:    `TEST-${Date.now()}`,
    customer_id: ctx.katana_customer_id,
    sales_order_rows: [{
      variant_id:     firstMilestone.katana_variant_id,
      quantity:       1,
      price_per_unit: 0.01,
      tax_rate_id:    DEFAULT_TAX_RATE_ID,
    }],
  };

  // Fire. Capture everything for the caller — request, response, status,
  // duration — so the inline details block on the quote page can show
  // the real Katana shape without us having to log-mine.
  let result;
  try {
    result = await apiPost(env, '/sales_orders', body);
  } catch (err) {
    return jsonError(502, `Katana POST failed: ${String(err && err.message || err)}`);
  }

  return new Response(JSON.stringify({
    ok: !!result.ok,
    status: result.status,
    duration_ms: result.durationMs,
    request_sent: body,
    katana_response: result.body,
    katana_response_raw: typeof result.body === 'string' ? result.body : null,
    url: result.url,
  }, null, 2), {
    status: 200, // The diagnostic endpoint always returns 200 to the caller —
                 // the Katana status is in the JSON. This way the UI can
                 // unambiguously show success/failure without juggling HTTP
                 // codes.
    headers: { 'content-type': 'application/json' },
  });
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
