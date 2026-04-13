// functions/opportunities/[id]/quotes/[quoteId]/lines/index.js
//
// POST /opportunities/:id/quotes/:quoteId/lines — add a line item.
// If a cost_build_id is provided, the line's unit_price is auto-set
// from the cost build's computed quote price.
// Recomputes the quote's subtotal_price and total_price in the same batch.

import { one, all, stmt, batch } from '../../../../../lib/db.js';
import { auditStmt } from '../../../../../lib/audit.js';
import { uuid, now } from '../../../../../lib/ids.js';
import { redirectWithFlash, formBody } from '../../../../../lib/http.js';
import { validateQuoteLine } from '../../../../../lib/validators.js';
import { loadCostBuildBundle, loadPricingSettings, computeFromBundle } from '../../../../../lib/pricing.js';

const READ_ONLY_STATUSES = new Set([
  'accepted',
  'rejected',
  'superseded',
  'expired',
]);

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const oppId = params.id;
  const quoteId = params.quoteId;

  const quote = await one(
    env.DB,
    'SELECT id, number, revision, status, opportunity_id, tax_amount FROM quotes WHERE id = ?',
    [quoteId]
  );
  if (!quote || quote.opportunity_id !== oppId) {
    return new Response('Quote not found', { status: 404 });
  }
  if (READ_ONLY_STATUSES.has(quote.status)) {
    return redirectWithFlash(
      `/opportunities/${oppId}/quotes/${quoteId}`,
      `Cannot add lines to a ${quote.status} quote.`,
      'error'
    );
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

  // If a cost build is linked to this line, auto-set unit_price from
  // the cost build's computed quote price.
  const lineCbId = input.cost_build_id || null;
  if (lineCbId) {
    const cbPrice = await getCostBuildPrice(env.DB, lineCbId);
    if (cbPrice != null) {
      value.unit_price = cbPrice;
    }
  }

  const id = uuid();
  const ts = now();
  const extended = Number(value.quantity) * Number(value.unit_price);

  // sort_order: next after the current max (1-based-ish, defaults to 0
  // when the quote has no lines yet).
  const maxRow = await one(
    env.DB,
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort FROM quote_lines WHERE quote_id = ?',
    [quoteId]
  );
  const sortOrder = Number(maxRow?.next_sort ?? 0);

  await batch(env.DB, [
    stmt(
      env.DB,
      `INSERT INTO quote_lines
         (id, quote_id, sort_order, item_type, description, quantity, unit,
          unit_price, extended_price, notes, cost_build_id,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               ?, ?)`,
      [
        id,
        quoteId,
        sortOrder,
        value.item_type,
        value.description,
        value.quantity,
        value.unit,
        value.unit_price,
        extended,
        value.notes,
        lineCbId,
        ts,
        ts,
      ]
    ),
    // Recompute totals.
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
      entityId: id,
      eventType: 'created',
      user,
      summary: `Added line to ${quote.number} Rev ${quote.revision}: ${value.description}`,
      changes: {
        quote_id: quoteId,
        description: value.description,
        quantity: value.quantity,
        unit_price: value.unit_price,
        extended_price: extended,
        cost_build_id: lineCbId,
      },
    }),
  ]);

  return redirectWithFlash(
    `/opportunities/${oppId}/quotes/${quoteId}`,
    'Line added.'
  );
}

/**
 * Compute the quote price from a cost build using the pricing engine.
 * Returns the effective quote price, or null if the cost build has no
 * meaningful data to price from.
 */
async function getCostBuildPrice(db, costBuildId) {
  const bundle = await loadCostBuildBundle(db, costBuildId);
  if (!bundle) return null;
  const settings = await loadPricingSettings(db);
  const { pricing } = computeFromBundle(bundle, settings);
  return pricing.effective.quote ?? null;
}
