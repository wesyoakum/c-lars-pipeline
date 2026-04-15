// functions/opportunities/[id]/quotes/[quoteId]/lines/[lineId]/index.js
//
// POST /opportunities/:id/quotes/:quoteId/lines/:lineId — update a line item.
// Recomputes the parent quote's subtotal_price and total_price.

import { one, stmt, batch } from '../../../../../../lib/db.js';
import { auditStmt, diff } from '../../../../../../lib/audit.js';
import { now } from '../../../../../../lib/ids.js';
import { redirectWithFlash, formBody } from '../../../../../../lib/http.js';
import { validateQuoteLine } from '../../../../../../lib/validators.js';
import { quoteTotalsRecomputeStmt } from '../../../../../../lib/pricing.js';

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
    // Fetch the updated totals to send back
    const updated = await one(env.DB,
      'SELECT subtotal_price, total_price FROM quotes WHERE id = ?', [quoteId]);
    return new Response(JSON.stringify({
      ok: true,
      lineId,
      extended_price: extended,
      subtotal_price: updated?.subtotal_price ?? 0,
      total_price: updated?.total_price ?? 0,
    }), { headers: { 'content-type': 'application/json' } });
  }

  return redirectWithFlash(
    `/opportunities/${oppId}/quotes/${quoteId}`,
    'Line saved.'
  );
}
