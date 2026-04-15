// functions/opportunities/[id]/quotes/[quoteId]/lines/[lineId]/index.js
//
// POST /opportunities/:id/quotes/:quoteId/lines/:lineId — update a line item.
// Recomputes the parent quote's subtotal_price and total_price.

import { one, stmt, batch } from '../../../../../../lib/db.js';
import { auditStmt, diff } from '../../../../../../lib/audit.js';
import { now } from '../../../../../../lib/ids.js';
import { redirectWithFlash, formBody } from '../../../../../../lib/http.js';
import { validateQuoteLine } from '../../../../../../lib/validators.js';
import {
  quoteTotalsRecomputeStmt,
  computeLineExtendedPrice,
} from '../../../../../../lib/pricing.js';

const READ_ONLY_STATUSES = new Set([
  'accepted',
  'rejected',
  'superseded',
  'expired',
]);

const LINE_FIELDS = [
  'item_type',
  'title',
  'part_number',
  'description',
  'quantity',
  'unit',
  'unit_price',
  'extended_price',
  'notes',
  'line_notes',
  'is_option',
  'discount_amount',
  'discount_pct',
  'discount_description',
  'discount_is_phantom',
  // T3.4 Sub-feature A — line_type tags the line with a hybrid-quote
  // section (spares / service / eps / refurb_*). NULL on single-type
  // quotes.
  'line_type',
];

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
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
      `Cannot edit lines on a ${quote.status} quote.`,
      'error'
    );
  }

  const before = await one(
    env.DB,
    'SELECT * FROM quote_lines WHERE id = ? AND quote_id = ?',
    [lineId, quoteId]
  );
  if (!before) {
    return new Response('Line not found', { status: 404 });
  }

  const input = await formBody(request);
  const { ok, value, errors } = validateQuoteLine(input);
  if (!ok) {
    const firstErr = Object.values(errors)[0] ?? 'Invalid line item.';
    return redirectWithFlash(
      `/opportunities/${oppId}/quotes/${quoteId}`,
      firstErr,
      'error'
    );
  }

  const ts = now();
  // T3.2 Phase 2 — extended_price bakes in the line's own real discount
  // (phantom discounts don't reduce the stored value; they mark up at
  // render time). The header discount is still applied separately via
  // quoteTotalsRecomputeStmt.
  const extended = computeLineExtendedPrice(value);

  const after = {
    ...before,
    ...value,
    extended_price: extended,
  };
  const changes = diff(before, after, LINE_FIELDS);

  await batch(env.DB, [
    stmt(
      env.DB,
      `UPDATE quote_lines
          SET item_type = ?,
              title = ?,
              part_number = ?,
              description = ?,
              quantity = ?,
              unit = ?,
              unit_price = ?,
              extended_price = ?,
              notes = ?,
              line_notes = ?,
              is_option = ?,
              discount_amount = ?,
              discount_pct = ?,
              discount_description = ?,
              discount_is_phantom = ?,
              line_type = ?,
              updated_at = ?
        WHERE id = ? AND quote_id = ?`,
      [
        value.item_type,
        value.title,
        value.part_number,
        value.description,
        value.quantity,
        value.unit,
        value.unit_price,
        extended,
        value.notes,
        value.line_notes,
        value.is_option ?? 0,
        value.discount_amount ?? null,
        value.discount_pct ?? null,
        value.discount_description ?? null,
        value.discount_is_phantom ?? 0,
        value.line_type ?? null,
        ts,
        lineId,
        quoteId,
      ]
    ),
    quoteTotalsRecomputeStmt(env.DB, quoteId, ts),
    auditStmt(env.DB, {
      entityType: 'quote_line',
      entityId: lineId,
      eventType: 'updated',
      user,
      summary: `Updated line on ${quote.number} Rev ${quote.revision}: ${value.description}`,
      changes,
    }),
  ]);

  // If the client accepts JSON (fetch auto-save), return JSON instead of redirect
  const accept = request.headers.get('accept') || '';
  if (accept.includes('application/json')) {
    // Fetch the updated totals to send back. Include tax_amount so the
    // client can derive discount_applied = subtotal - total + tax.
    const updated = await one(env.DB,
      'SELECT subtotal_price, total_price, tax_amount FROM quotes WHERE id = ?',
      [quoteId]);
    const sub = Number(updated?.subtotal_price ?? 0);
    const tot = Number(updated?.total_price ?? 0);
    const tax = Number(updated?.tax_amount ?? 0);
    const discountApplied = Math.max(0, sub - (tot - tax));
    return new Response(JSON.stringify({
      ok: true,
      lineId,
      extended_price: extended,
      subtotal_price: sub,
      total_price: tot,
      discount_applied: discountApplied,
    }), { headers: { 'content-type': 'application/json' } });
  }

  return redirectWithFlash(
    `/opportunities/${oppId}/quotes/${quoteId}`,
    'Line saved.'
  );
}
