// functions/opportunities/[id]/quotes/[quoteId]/lines/[lineId]/index.js
//
// POST /opportunities/:id/quotes/:quoteId/lines/:lineId — update a line
// item. Recomputes the parent quote's subtotal_price and total_price
// in the same batch.

import { one, stmt, batch } from '../../../../../../lib/db.js';
import { auditStmt, diff } from '../../../../../../lib/audit.js';
import { now } from '../../../../../../lib/ids.js';
import { redirectWithFlash, formBody } from '../../../../../../lib/http.js';
import { validateQuoteLine } from '../../../../../../lib/validators.js';
import { resolveCostRef } from '../../../../../../lib/quote-cost-ref.js';

const READ_ONLY_STATUSES = new Set([
  'accepted',
  'rejected',
  'superseded',
  'expired',
]);

const LINE_FIELDS = [
  'item_type',
  'description',
  'quantity',
  'unit',
  'unit_price',
  'extended_price',
  'notes',
  'cost_ref_type',
  'cost_ref_id',
  'cost_ref_amount',
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
  const extended = Number(value.quantity) * Number(value.unit_price);

  // Resolve cost reference (if a cost build item was selected).
  const costRef = await resolveCostRef(env.DB, input.cost_ref);

  const after = {
    ...before,
    ...value,
    extended_price: extended,
    cost_ref_type: costRef.cost_ref_type,
    cost_ref_id: costRef.cost_ref_id,
    cost_ref_amount: costRef.cost_ref_amount,
  };
  const changes = diff(before, after, LINE_FIELDS);

  await batch(env.DB, [
    stmt(
      env.DB,
      `UPDATE quote_lines
          SET item_type = ?,
              description = ?,
              quantity = ?,
              unit = ?,
              unit_price = ?,
              extended_price = ?,
              notes = ?,
              cost_ref_type = ?,
              cost_ref_id = ?,
              cost_ref_amount = ?,
              updated_at = ?
        WHERE id = ? AND quote_id = ?`,
      [
        value.item_type,
        value.description,
        value.quantity,
        value.unit,
        value.unit_price,
        extended,
        value.notes,
        costRef.cost_ref_type,
        costRef.cost_ref_id,
        costRef.cost_ref_amount,
        ts,
        lineId,
        quoteId,
      ]
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
      eventType: 'updated',
      user,
      summary: `Updated line on ${quote.number} Rev ${quote.revision}: ${value.description}`,
      changes,
    }),
  ]);

  return redirectWithFlash(
    `/opportunities/${oppId}/quotes/${quoteId}`,
    'Line saved.'
  );
}
