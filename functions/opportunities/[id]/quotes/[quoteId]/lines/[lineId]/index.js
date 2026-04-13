// functions/opportunities/[id]/quotes/[quoteId]/lines/[lineId]/index.js
//
// POST /opportunities/:id/quotes/:quoteId/lines/:lineId — update a line
// item. If a cost_build_id is set, the unit_price is auto-set from the
// cost build's computed quote price. Recomputes the parent quote's
// subtotal_price and total_price in the same batch.

import { one, stmt, batch } from '../../../../../../lib/db.js';
import { auditStmt, diff } from '../../../../../../lib/audit.js';
import { now } from '../../../../../../lib/ids.js';
import { redirectWithFlash, formBody } from '../../../../../../lib/http.js';
import { validateQuoteLine } from '../../../../../../lib/validators.js';
import { loadCostBuildBundle, loadPricingSettings, computeFromBundle } from '../../../../../../lib/pricing.js';

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
  'cost_build_id',
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

  // If a cost build is linked to this line, auto-set unit_price.
  const lineCbId = input.cost_build_id || null;
  if (lineCbId) {
    const cbPrice = await getCostBuildPrice(env.DB, lineCbId);
    if (cbPrice != null) {
      value.unit_price = cbPrice;
    }
  }

  const ts = now();
  const extended = Number(value.quantity) * Number(value.unit_price);

  const after = {
    ...before,
    ...value,
    extended_price: extended,
    cost_build_id: lineCbId,
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
              cost_build_id = ?,
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
        lineCbId,
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

/**
 * Compute the quote price from a cost build using the pricing engine.
 */
async function getCostBuildPrice(db, costBuildId) {
  const bundle = await loadCostBuildBundle(db, costBuildId);
  if (!bundle) return null;
  const settings = await loadPricingSettings(db);
  const { pricing } = computeFromBundle(bundle, settings);
  return pricing.effective.quote ?? null;
}
