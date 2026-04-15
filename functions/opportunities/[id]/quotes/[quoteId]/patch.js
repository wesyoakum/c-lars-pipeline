// functions/opportunities/[id]/quotes/[quoteId]/patch.js
//
// POST /opportunities/:id/quotes/:quoteId/patch — JSON auto-save
//
// Accepts { field: value } pairs, updates only the provided fields.
// Returns { ok: true } on success or { ok: false, error: '...' }.

import { one, stmt, batch } from '../../../../lib/db.js';
import { auditStmt, diff } from '../../../../lib/audit.js';
import { now } from '../../../../lib/ids.js';
import { quoteTotalsRecomputeStmt } from '../../../../lib/pricing.js';

const READ_ONLY_STATUSES = new Set([
  'issued', 'revision_issued', 'accepted', 'rejected', 'expired', 'dead',
]);

const PATCHABLE = new Set([
  'quote_type', 'title', 'description', 'valid_until', 'incoterms',
  'payment_terms', 'delivery_terms', 'delivery_estimate',
  'tax_amount', 'notes_internal', 'notes_customer',
  // T3.2 Phase 1 — header-level discount
  'discount_amount', 'discount_pct', 'discount_description', 'discount_is_phantom',
]);

// Fields that affect the stored quote totals; changing any of them
// triggers a subtotal/total recompute via the shared helper in pricing.js.
const RECOMPUTE_FIELDS = new Set([
  'tax_amount',
  'discount_amount', 'discount_pct', 'discount_is_phantom',
]);

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const oppId = params.id;
  const quoteId = params.quoteId;

  const before = await one(env.DB, 'SELECT * FROM quotes WHERE id = ?', [quoteId]);
  if (!before || before.opportunity_id !== oppId) {
    return json({ ok: false, error: 'Not found' }, 404);
  }
  if (READ_ONLY_STATUSES.has(before.status)) {
    return json({ ok: false, error: `Cannot edit a ${before.status} quote` }, 400);
  }

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }

  const sets = [];
  const vals = [];
  const fields = [];

  for (const [k, v] of Object.entries(body)) {
    if (!PATCHABLE.has(k)) continue;
    sets.push(`${k} = ?`);
    // Numeric coercion for the toggle so checkbox-style inputs ('on'/'off'
    // or '1'/'0') land as 0/1 integers in D1.
    let storedVal;
    if (v === '' || v === null || v === undefined) {
      storedVal = null;
    } else if (k === 'discount_is_phantom') {
      storedVal = (v === 1 || v === '1' || v === true || v === 'true' || v === 'on') ? 1 : 0;
    } else {
      storedVal = v;
    }
    vals.push(storedVal);
    fields.push(k);
  }

  if (sets.length === 0) return json({ ok: true });

  const ts = now();
  sets.push('updated_at = ?');
  vals.push(ts);
  vals.push(quoteId);

  const after = { ...before };
  for (let i = 0; i < fields.length; i++) {
    // vals is shaped like [val0, val1, ..., ts, quoteId] — the first
    // `fields.length` entries correspond to PATCHABLE fields in order.
    after[fields[i]] = vals[i];
  }
  const changes = diff(before, after, fields);

  const statements = [
    stmt(env.DB, `UPDATE quotes SET ${sets.join(', ')} WHERE id = ?`, vals),
  ];

  // If any field that affects totals changed, run the shared recompute
  // AFTER the UPDATE. The recompute reads discount_* and tax_amount from
  // the row so it must see the new values.
  const needsRecompute = fields.some((f) => RECOMPUTE_FIELDS.has(f));
  if (needsRecompute) {
    statements.push(quoteTotalsRecomputeStmt(env.DB, quoteId, ts));
  }

  statements.push(
    auditStmt(env.DB, {
      entityType: 'quote',
      entityId: quoteId,
      eventType: 'updated',
      user,
      summary: `Updated ${before.number} Rev ${before.revision}`,
      changes,
    })
  );

  await batch(env.DB, statements);

  // Fetch the recomputed totals so the client can update its display
  // without a full page reload. Include discount_applied so the visible
  // "Discount $X" cell updates live when the user edits the fields.
  let totals = null;
  if (needsRecompute) {
    const row = await one(
      env.DB,
      `SELECT subtotal_price, total_price, tax_amount,
              discount_amount, discount_pct, discount_is_phantom
         FROM quotes WHERE id = ?`,
      [quoteId]
    );
    const sub = Number(row?.subtotal_price ?? 0);
    const tot = Number(row?.total_price ?? 0);
    const tax = Number(row?.tax_amount ?? 0);
    const discountApplied = Math.max(0, sub - (tot - tax));
    totals = {
      subtotal_price: sub,
      total_price: tot,
      discount_applied: discountApplied,
    };
  }

  return json({ ok: true, totals });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
