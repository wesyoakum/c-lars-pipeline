// POST /opportunities/:id/quotes/:quoteId/populate-from-cost-build
//
// Reads the linked cost build's DM selections and labor selections,
// then creates quote lines from them. DM items become product lines
// with their library cost as unit_price. Labor items become labor lines
// with the total hours × rate as unit_price.
//
// Does NOT delete existing lines — it appends. The user can delete
// unwanted lines manually after populating.

import { one, all, stmt, batch } from '../../../../lib/db.js';
import { auditStmt } from '../../../../lib/audit.js';
import { uuid, now } from '../../../../lib/ids.js';
import { redirectWithFlash } from '../../../../lib/http.js';
import { loadCostBuildBundle, loadPricingSettings } from '../../../../lib/pricing.js';

const READ_ONLY_STATUSES = new Set([
  'accepted', 'rejected', 'superseded', 'expired',
]);

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const oppId = params.id;
  const quoteId = params.quoteId;

  const quote = await one(
    env.DB,
    'SELECT id, number, revision, status, opportunity_id, cost_build_id, tax_amount FROM quotes WHERE id = ?',
    [quoteId]
  );
  if (!quote || quote.opportunity_id !== oppId) {
    return new Response('Quote not found', { status: 404 });
  }
  if (READ_ONLY_STATUSES.has(quote.status)) {
    return redirectWithFlash(
      `/opportunities/${oppId}/quotes/${quoteId}`,
      `Cannot modify a ${quote.status} quote.`,
      'error'
    );
  }
  if (!quote.cost_build_id) {
    return redirectWithFlash(
      `/opportunities/${oppId}/quotes/${quoteId}`,
      'No cost build is linked to this quote. Select one first.',
      'error'
    );
  }

  const bundle = await loadCostBuildBundle(env.DB, quote.cost_build_id);
  if (!bundle) {
    return redirectWithFlash(
      `/opportunities/${oppId}/quotes/${quoteId}`,
      'Linked cost build not found.',
      'error'
    );
  }

  const settings = await loadPricingSettings(env.DB);
  const defaultRate = Number(settings.defaultLaborRate) || 0;

  // Find the current max sort_order so we append after existing lines.
  const maxRow = await one(
    env.DB,
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort FROM quote_lines WHERE quote_id = ?',
    [quoteId]
  );
  let sortOrder = Number(maxRow?.next_sort ?? 0);

  const ts = now();
  const statements = [];
  let addedCount = 0;

  // --- DM selections → product lines ------------------------------------
  for (const dm of (bundle.dmSelections || [])) {
    const id = uuid();
    const cost = Number(dm.cost) || 0;
    statements.push(
      stmt(env.DB,
        `INSERT INTO quote_lines
           (id, quote_id, sort_order, item_type, description, quantity, unit,
            unit_price, extended_price, notes,
            cost_ref_type, cost_ref_id, cost_ref_amount,
            created_at, updated_at)
         VALUES (?, ?, ?, 'product', ?, 1, 'ea', ?, ?, NULL,
                 'dm', ?, ?,
                 ?, ?)`,
        [id, quoteId, sortOrder, dm.description, cost, cost,
         dm.id, cost,
         ts, ts]
      )
    );
    sortOrder++;
    addedCount++;
  }

  // --- Labor selections → labor lines ------------------------------------
  // Each labor library item may have multiple workcenter entries.
  // We create one quote line per labor item with total cost = sum(hours × rate).
  for (const li of (bundle.laborSelections || [])) {
    const id = uuid();
    const totalCost = (li.entries || []).reduce((acc, e) => {
      const rate = e.rate != null ? Number(e.rate) : defaultRate;
      return acc + (Number(e.hours) || 0) * rate;
    }, 0);
    const totalHours = (li.entries || []).reduce((acc, e) => acc + (Number(e.hours) || 0), 0);
    statements.push(
      stmt(env.DB,
        `INSERT INTO quote_lines
           (id, quote_id, sort_order, item_type, description, quantity, unit,
            unit_price, extended_price, notes,
            cost_ref_type, cost_ref_id, cost_ref_amount,
            created_at, updated_at)
         VALUES (?, ?, ?, 'labor', ?, ?, 'hr', ?, ?, NULL,
                 'labor', ?, ?,
                 ?, ?)`,
        [id, quoteId, sortOrder, li.description, totalHours, totalCost / (totalHours || 1), totalCost,
         li.id, totalCost,
         ts, ts]
      )
    );
    sortOrder++;
    addedCount++;
  }

  // --- Current-project labor → one aggregate line -------------------------
  // If the cost build has per-workcenter labor hours (the "Current Project"
  // section), create a single summary line. No cost_ref since this is an
  // aggregate of multiple workcenters, not a single library item.
  const currentLabor = bundle.currentLabor || [];
  if (currentLabor.length > 0) {
    const id = uuid();
    const totalHours = currentLabor.reduce((acc, e) => acc + (Number(e.hours) || 0), 0);
    const totalCost = currentLabor.reduce((acc, e) => {
      const rate = e.rate != null ? Number(e.rate) : defaultRate;
      return acc + (Number(e.hours) || 0) * rate;
    }, 0);
    if (totalHours > 0) {
      const blendedRate = totalCost / totalHours;
      statements.push(
        stmt(env.DB,
          `INSERT INTO quote_lines
             (id, quote_id, sort_order, item_type, description, quantity, unit,
              unit_price, extended_price, notes, created_at, updated_at)
           VALUES (?, ?, ?, 'labor', 'Project labor', ?, 'hr', ?, ?, NULL, ?, ?)`,
          [id, quoteId, sortOrder, totalHours, blendedRate, totalCost, ts, ts]
        )
      );
      sortOrder++;
      addedCount++;
    }
  }

  if (addedCount === 0) {
    return redirectWithFlash(
      `/opportunities/${oppId}/quotes/${quoteId}`,
      'No items found in the linked cost build to populate.',
      'error'
    );
  }

  // Recompute quote totals.
  statements.push(
    stmt(env.DB,
      `UPDATE quotes
          SET subtotal_price = (SELECT COALESCE(SUM(extended_price), 0) FROM quote_lines WHERE quote_id = ?),
              total_price    = (SELECT COALESCE(SUM(extended_price), 0) FROM quote_lines WHERE quote_id = ?) + COALESCE(tax_amount, 0),
              updated_at     = ?
        WHERE id = ?`,
      [quoteId, quoteId, ts, quoteId]
    )
  );

  statements.push(
    auditStmt(env.DB, {
      entityType: 'quote',
      entityId: quoteId,
      eventType: 'updated',
      user,
      summary: `Populated ${addedCount} line(s) from cost build on ${quote.number} Rev ${quote.revision}`,
      changes: { lines_added: addedCount, cost_build_id: quote.cost_build_id },
    })
  );

  await batch(env.DB, statements);

  return redirectWithFlash(
    `/opportunities/${oppId}/quotes/${quoteId}`,
    `Added ${addedCount} line(s) from cost build.`
  );
}
