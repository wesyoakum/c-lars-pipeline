// functions/opportunities/[id]/quotes/[quoteId]/lines/[lineId]/price-build/patch.js
//
// POST — JSON auto-save for the pricing engine.
//
// Accepts the full set of editable fields as JSON, validates, saves,
// and returns the recomputed pricing state so the client can update
// totals/margins/references without a page reload.

import { one, all, stmt, batch } from '../../../../../../../lib/db.js';
import { auditStmt } from '../../../../../../../lib/audit.js';
import { validateCostBuild, validateWorkcenterEntries } from '../../../../../../../lib/validators.js';
import { uuid, now } from '../../../../../../../lib/ids.js';
import {
  loadPricingSettings,
  loadCostBuildBundle,
  computeFromBundle,
  workcenterEntryCost,
} from '../../../../../../../lib/pricing.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const { id: oppId, quoteId, lineId } = params;

  // Verify the line exists and belongs to the right opp/quote
  const line = await one(
    env.DB,
    `SELECT ql.*, q.opportunity_id, q.number AS quote_number, q.revision
       FROM quote_lines ql
       JOIN quotes q ON q.id = ql.quote_id
      WHERE ql.id = ? AND q.id = ? AND q.opportunity_id = ?`,
    [lineId, quoteId, oppId]
  );
  if (!line) return json({ ok: false, error: 'Line item not found' }, 404);

  const build = await one(env.DB, 'SELECT * FROM cost_builds WHERE quote_line_id = ?', [lineId]);
  if (!build) return json({ ok: false, error: 'No price build' }, 404);
  if (build.status === 'locked') return json({ ok: false, error: 'Locked' }, 409);

  let input;
  try { input = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }

  const buildId = build.id;
  const settings = await loadPricingSettings(env.DB);

  // ── Validate price build scalars ──
  const { ok, value, errors } = validateCostBuild(input);

  // ── Validate workcenter entries ──
  const wcRes = validateWorkcenterEntries(
    input.current_hours || {},
    input.current_rate || {},
    settings.workcenters
  );

  const allErrors = { ...(ok ? {} : errors), ...(wcRes.ok ? {} : wcRes.errors) };
  if (Object.keys(allErrors).length) {
    return json({ ok: false, errors: allErrors }, 422);
  }

  const asArray = (v) => v === undefined ? [] : Array.isArray(v) ? v : [v];
  const dmIds = asArray(input.dm_item_ids);
  const laborIds = asArray(input.labor_item_ids);
  const ts = now();

  const statements = [
    stmt(env.DB,
      `UPDATE cost_builds
          SET label = ?, notes = ?,
              dm_user_cost = ?, dl_user_cost = ?, imoh_user_cost = ?, other_user_cost = ?,
              quote_price_user = ?,
              use_dm_library = ?, use_labor_library = ?,
              updated_at = ?
        WHERE id = ?`,
      [value.label, value.notes,
       value.dm_user_cost, value.dl_user_cost, value.imoh_user_cost, value.other_user_cost,
       value.quote_price_user, value.use_dm_library, value.use_labor_library,
       ts, buildId]
    ),
    stmt(env.DB, 'DELETE FROM cost_build_labor WHERE cost_build_id = ?', [buildId]),
    ...wcRes.value.map((e) =>
      stmt(env.DB, 'INSERT INTO cost_build_labor (cost_build_id, workcenter, hours, rate) VALUES (?, ?, ?, ?)', [buildId, e.workcenter, e.hours, e.rate])
    ),
    stmt(env.DB, 'DELETE FROM cost_build_dm_selections WHERE cost_build_id = ?', [buildId]),
    ...dmIds.map((id) =>
      stmt(env.DB, 'INSERT OR IGNORE INTO cost_build_dm_selections (cost_build_id, dm_item_id) VALUES (?, ?)', [buildId, id])
    ),
    stmt(env.DB, 'DELETE FROM cost_build_labor_selections WHERE cost_build_id = ?', [buildId]),
    ...laborIds.map((id) =>
      stmt(env.DB, 'INSERT OR IGNORE INTO cost_build_labor_selections (cost_build_id, labor_item_id) VALUES (?, ?)', [buildId, id])
    ),
  ];

  // Recompute pricing from the updated values
  const bundle = await loadCostBuildBundle(env.DB, buildId);
  if (bundle) {
    bundle.build.dm_user_cost = value.dm_user_cost;
    bundle.build.dl_user_cost = value.dl_user_cost;
    bundle.build.imoh_user_cost = value.imoh_user_cost;
    bundle.build.other_user_cost = value.other_user_cost;
    bundle.build.quote_price_user = value.quote_price_user;
    bundle.build.use_dm_library = value.use_dm_library;
    bundle.build.use_labor_library = value.use_labor_library;

    // Temporarily apply new workcenter entries
    bundle.currentLabor = wcRes.value.map((e) => ({
      workcenter: e.workcenter,
      hours: e.hours,
      rate: e.rate,
    }));

    // Temporarily apply new DM selections
    if (dmIds.length > 0) {
      const allDm = await all(env.DB, 'SELECT id, cost FROM dm_items WHERE id IN (' + dmIds.map(() => '?').join(',') + ')', dmIds);
      bundle.dmSelections = allDm;
    } else {
      bundle.dmSelections = [];
    }

    // Temporarily apply new labor selections
    if (laborIds.length > 0) {
      const allLabor = await all(env.DB, 'SELECT id, description FROM labor_items WHERE id IN (' + laborIds.map(() => '?').join(',') + ')', laborIds);
      bundle.laborSelections = allLabor;
    } else {
      bundle.laborSelections = [];
    }

    const { pricing, totals } = computeFromBundle(bundle, settings);

    // Update the quote line's unit_price from the computed quote price
    if (pricing.effective.quote !== null) {
      const unitPrice = pricing.effective.quote;
      const qty = Number(line.quantity) || 1;
      const extended = qty * unitPrice;
      statements.push(
        stmt(env.DB,
          'UPDATE quote_lines SET unit_price = ?, extended_price = ?, updated_at = ? WHERE id = ?',
          [unitPrice, extended, ts, lineId]
        )
      );
    }

    statements.push(
      auditStmt(env.DB, {
        entityType: 'cost_build',
        entityId: buildId,
        eventType: 'updated',
        user,
        summary: `Updated price build for "${line.description}"`,
        changes: { label: value.label },
      })
    );

    await batch(env.DB, statements);

    // Compute workcenter costs for the response
    const wcCosts = {};
    for (const e of wcRes.value) {
      wcCosts[e.workcenter] = workcenterEntryCost(e.hours, e.rate, settings);
    }

    return json({
      ok: true,
      pricing: {
        effective: pricing.effective,
        margin: pricing.margin,
        references: pricing.references,
        notes: pricing.notes,
        auto: pricing.auto,
        linked: pricing.linked,
      },
      totals,
      wcCosts,
    });
  }

  // Fallback: no bundle (shouldn't happen)
  statements.push(
    auditStmt(env.DB, {
      entityType: 'cost_build',
      entityId: buildId,
      eventType: 'updated',
      user,
      summary: `Updated price build for "${line.description}"`,
      changes: { label: value.label },
    })
  );
  await batch(env.DB, statements);
  return json({ ok: true });
}
