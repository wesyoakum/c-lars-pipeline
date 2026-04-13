// functions/opportunities/[id]/quotes/[quoteId]/patch.js
//
// POST /opportunities/:id/quotes/:quoteId/patch — JSON auto-save
//
// Accepts { field: value } pairs, updates only the provided fields.
// Returns { ok: true } on success or { ok: false, error: '...' }.

import { one, stmt, batch } from '../../../../lib/db.js';
import { auditStmt, diff } from '../../../../lib/audit.js';
import { now } from '../../../../lib/ids.js';

const READ_ONLY_STATUSES = new Set([
  'issued', 'revision_issued', 'accepted', 'rejected', 'expired', 'dead',
]);

const PATCHABLE = new Set([
  'quote_type', 'title', 'description', 'valid_until', 'incoterms',
  'payment_terms', 'delivery_terms', 'delivery_estimate',
  'tax_amount', 'notes_internal', 'notes_customer',
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
    vals.push(v === '' ? null : v);
    fields.push(k);
  }

  if (sets.length === 0) return json({ ok: true });

  const ts = now();
  sets.push('updated_at = ?');
  vals.push(ts);
  vals.push(quoteId);

  const after = { ...before };
  for (const f of fields) after[f] = body[f] === '' ? null : body[f];
  const changes = diff(before, after, fields);

  // Recompute totals if tax changed
  if (fields.includes('tax_amount')) {
    const lineTotals = await one(
      env.DB,
      `SELECT COALESCE(SUM(extended_price), 0) AS subtotal FROM quote_lines WHERE quote_id = ?`,
      [quoteId]
    );
    const sub = Number(lineTotals?.subtotal ?? 0);
    const tot = sub + Number(after.tax_amount ?? 0);
    sets.splice(sets.length - 1, 0, 'subtotal_price = ?', 'total_price = ?');
    vals.splice(vals.length - 1, 0, sub, tot);
  }

  await batch(env.DB, [
    stmt(env.DB, `UPDATE quotes SET ${sets.join(', ')} WHERE id = ?`, vals),
    auditStmt(env.DB, {
      entityType: 'quote',
      entityId: quoteId,
      eventType: 'updated',
      user,
      summary: `Updated ${before.number} Rev ${before.revision}`,
      changes,
    }),
  ]);

  return json({ ok: true });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
