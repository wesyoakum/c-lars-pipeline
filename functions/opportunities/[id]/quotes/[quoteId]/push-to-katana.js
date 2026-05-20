// functions/opportunities/[id]/quotes/[quoteId]/push-to-katana.js
//
// POST /opportunities/:id/quotes/:quoteId/push-to-katana
//
// Step 2 of the incremental Katana rebuild. Creates ONE Katana sales
// order per Pipeline quote line — Adam's D079 pattern. Each line's
// SO has N rows (one per milestone in the saved milestone map), with
// price_per_unit = line.unit_price × milestone_pct / 100 and quantity
// from the line.
//
// Body (JSON):
//   {
//     order_no:        string,                // base name; per-line
//                                             // SOs append "-01", "-02"
//     customer_ref:    string,                // optional, free text
//                                             // (same on every SO)
//     delivery_date:   'YYYY-MM-DD',          // optional
//                                             // (same on every SO)
//     additional_info: string,                // optional
//                                             // (line title prepended per SO)
//   }
//
// The milestones array the modal used to send is ignored — Step 2 uses
// the saved milestone map percentages directly. Step 3 will add per-
// quote payment-terms editing.
//
// Validations:
//   1. Account has katana_customer_id
//   2. Quote has at least one active line
//   3. Milestone map is configured
//   4. order_no base name is non-empty
// Per-line behavior:
//   * Lines with an existing katana_sales_order_id are SKIPPED (not
//     re-pushed). Idempotent: re-clicking Push only pushes remaining
//     lines.
//   * Lines with unit_price === 0 are skipped (no billing to split).
//   * Per-line errors don't abort the run — other lines still push,
//     errors get stored on quote_lines.katana_push_error and surfaced
//     in the response.
//
// Returns { ok, pushed, skipped, errors, line_count } summary.

import { all, one, run, batch, stmt } from '../../../../lib/db.js';
import { auditStmt } from '../../../../lib/audit.js';
import { hasRole } from '../../../../lib/auth.js';
import { apiPost } from '../../../../lib/katana-client.js';
import { loadMilestoneMap } from '../../../../lib/katana-milestones.js';

// Hardcoded for v1. Both confirmed via the Katana probe (single
// location, single "No tax" rate). Step 6 will surface these as
// per-quote-type defaults on the /settings/katana-milestones page.
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
  catch { body = {}; }

  // 1. Load quote + opp + account.
  const ctx = await one(env.DB,
    `SELECT q.id AS quote_id, q.number AS quote_number, q.total_price,
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
    return jsonError(400, `account "${ctx.account_name}" has no Katana customer mapping. Set it at /settings/katana-customer-map first.`);
  }

  // 2. Load active quote lines.
  const lines = await all(env.DB,
    `SELECT id, sort_order, title, description, part_number,
            quantity, unit_price, extended_price,
            katana_sales_order_id, katana_sales_order_pushed_at
       FROM quote_lines
      WHERE quote_id = ?
        AND COALESCE(is_active, 1) = 1
        AND COALESCE(is_option, 0) = 0
      ORDER BY sort_order, id`,
    [quoteId]);
  if (!lines.length) return jsonError(400, 'quote has no active (non-option) lines to push');

  // 3. Load milestone map.
  const map = await loadMilestoneMap(env);
  if (!map || !Array.isArray(map.milestones) || map.milestones.length === 0) {
    return jsonError(400, 'Katana milestone map is not configured. Set it at /settings/katana-milestones first.');
  }

  // 4. Shared fields from body (apply to every per-line SO).
  const baseOrderNo = String(body?.order_no || ctx.quote_number || '').trim().slice(0, 60);
  if (!baseOrderNo) return jsonError(400, 'order_no base name is required');

  const customerRef = String(body?.customer_ref || '').trim().slice(0, 200);
  const additionalInfoBase = String(body?.additional_info || '').trim();

  const rawDeliveryDate = String(body?.delivery_date || '').trim();
  let deliveryDateIso = null;
  if (rawDeliveryDate) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rawDeliveryDate);
    if (m) deliveryDateIso = `${rawDeliveryDate}T17:00:00.000Z`;
    else   deliveryDateIso = rawDeliveryDate;
  }

  // 5. Push per line.
  const results = { pushed: [], skipped: [], errors: [] };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineIdx = i + 1; // 1-based for human-readable order_no suffixes
    const lineLabel = (line.title || line.description || '').toString().trim().slice(0, 80) || `Line ${lineIdx}`;

    // Idempotency: skip lines already linked to a Katana SO.
    if (line.katana_sales_order_id) {
      results.skipped.push({
        line_id: line.id,
        line_idx: lineIdx,
        title: lineLabel,
        reason: `already pushed as SO #${line.katana_sales_order_id}`,
        katana_sales_order_id: line.katana_sales_order_id,
      });
      continue;
    }

    const unitPrice = Number(line.unit_price) || 0;
    const qty = Number(line.quantity) || 0;
    if (unitPrice <= 0 || qty <= 0) {
      results.skipped.push({
        line_id: line.id,
        line_idx: lineIdx,
        title: lineLabel,
        reason: 'zero quantity or zero unit price',
      });
      continue;
    }

    // Build per-milestone rows: each row prices the line's unit by
    // the milestone's percentage. Quantity stays as the line's qty
    // so Katana's row totals reflect the real billing structure.
    let rolling = 0;
    const salesOrderRows = map.milestones.map((m, mi) => {
      const raw = unitPrice * (Number(m.percent) || 0) / 100;
      let pricePerUnit = Math.round(raw * 100) / 100;
      rolling += pricePerUnit;
      // Last row absorbs any 1-cent rounding drift so the per-line
      // total in Katana matches Pipeline's extended_price exactly.
      if (mi === map.milestones.length - 1) {
        const linePriceTarget = Math.round(unitPrice * 100) / 100;
        const drift = linePriceTarget - rolling;
        if (Math.abs(drift) > 0.001) {
          pricePerUnit = Math.round((pricePerUnit + drift) * 100) / 100;
        }
      }
      return {
        variant_id:     m.katana_variant_id,
        quantity:       qty,
        price_per_unit: pricePerUnit,
        tax_rate_id:    DEFAULT_TAX_RATE_ID,
      };
    });

    const orderNo = `${baseOrderNo}-${String(lineIdx).padStart(2, '0')}`.slice(0, 80);

    // Build per-line additional_info: line label + part# + any
    // user-provided notes from the modal.
    const noteParts = [];
    noteParts.push(lineLabel);
    if (line.part_number) noteParts.push(`P/N ${line.part_number}`);
    if (additionalInfoBase) noteParts.push(additionalInfoBase);
    const lineAdditionalInfo = noteParts.join(' — ').slice(0, 2000);

    const katanaBody = {
      order_no:        orderNo,
      customer_id:     ctx.katana_customer_id,
      location_id:     DEFAULT_LOCATION_ID,
      sales_order_rows: salesOrderRows,
      additional_info: lineAdditionalInfo,
    };
    if (customerRef)    katanaBody.customer_ref  = customerRef;
    if (deliveryDateIso) katanaBody.delivery_date = deliveryDateIso;

    // Push this one.
    let newId = null;
    let pushError = null;
    try {
      const r = await apiPost(env, '/sales_orders', katanaBody);
      if (!r.ok) {
        pushError = `Katana ${r.status}: ${typeof r.body === 'string' ? r.body.slice(0, 300) : JSON.stringify(r.body).slice(0, 300)}`;
      } else {
        const id = parseInt(r.body?.id, 10);
        if (Number.isFinite(id) && id > 0) newId = id;
        else pushError = `Katana returned no usable id: ${JSON.stringify(r.body).slice(0, 200)}`;
      }
    } catch (err) {
      pushError = `Katana request failed: ${String(err && err.message || err)}`;
    }

    if (newId) {
      const nowIso = new Date().toISOString();
      await batch(env.DB, [
        stmt(env.DB,
          `UPDATE quote_lines
              SET katana_sales_order_id        = ?,
                  katana_sales_order_pushed_at = ?,
                  katana_push_error            = NULL,
                  updated_at                   = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE id = ?`,
          [newId, nowIso, line.id]),
        auditStmt(env.DB, {
          entityType: 'quote_line',
          entityId:   line.id,
          eventType:  'updated',
          user,
          summary:    `Pushed quote line "${lineLabel}" to Katana as SO "${orderNo}" (#${newId}, $${(unitPrice * qty).toFixed(2)})`,
          changes: { katana_sales_order_id: { from: null, to: newId } },
        }),
      ]);
      results.pushed.push({
        line_id: line.id,
        line_idx: lineIdx,
        title: lineLabel,
        katana_sales_order_id: newId,
        order_no: orderNo,
        amount: Math.round(unitPrice * qty * 100) / 100,
      });
    } else {
      await run(env.DB,
        `UPDATE quote_lines
            SET katana_push_error = ?,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?`,
        [pushError, line.id]);
      results.errors.push({
        line_id: line.id,
        line_idx: lineIdx,
        title: lineLabel,
        order_no: orderNo,
        error: pushError,
      });
    }
  }

  // Roll up. ok = true only when nothing errored. The UI uses
  // pushed_count / line_count to drive the "N of M lines pushed" badge.
  return new Response(JSON.stringify({
    ok: results.errors.length === 0,
    line_count:    lines.length,
    pushed_count:  results.pushed.length,
    skipped_count: results.skipped.length,
    error_count:   results.errors.length,
    pushed:        results.pushed,
    skipped:       results.skipped,
    errors:        results.errors,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
