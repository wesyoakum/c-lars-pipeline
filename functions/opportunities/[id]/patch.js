// functions/opportunities/[id]/patch.js
//
// POST /opportunities/:id/patch — inline field save (JSON).
//
// Accepts { field, value } and updates a single field on the opportunity.
// Returns JSON { ok, field, value, error? }.

import { one, stmt, batch } from '../../lib/db.js';
import { auditStmt, diff } from '../../lib/audit.js';
import { now } from '../../lib/ids.js';

// Fields that may be patched inline, with optional coercion.
const PATCHABLE = new Set([
  'title', 'description', 'estimated_value_usd', 'probability',
  'rfq_format', 'source', 'transaction_type',
  'expected_close_date', 'rfq_received_date', 'rfq_due_date',
  'rfi_due_date', 'quoted_date',
  'account_id', 'primary_contact_id',
  'owner_user_id', 'salesperson_user_id',
  'bant_budget', 'bant_authority', 'bant_need', 'bant_timeline',
  'bant_authority_contact_id',
  'customer_po_number',
  // Internal-notes panel — non-customer-facing free text. Migration
  // 0058 added the column; the AI Inbox apply-requirements flow
  // appends here. The opportunity detail page now exposes it as a
  // yellow-tinted textarea below the description so the user can
  // read and edit what landed.
  'notes_internal',
  // Universal tri-state toggle (NULL = undecided, 1 = CO active,
  // 0 = no CO). Drives stage-picker filtering: hides CO-loop stages
  // when != 1 so the picker keeps a simple path from oc_submitted /
  // job_in_progress to completed.
  'change_order',
]);

function coerce(field, raw) {
  const v = typeof raw === 'string' ? raw.trim() : raw;
  if (v === '' || v === null || v === undefined) return null;
  if (field === 'estimated_value_usd') {
    const n = Number(v);
    return isNaN(n) ? null : n;
  }
  if (field === 'probability') {
    const n = parseInt(v, 10);
    return isNaN(n) ? null : Math.max(0, Math.min(100, n));
  }
  if (field === 'change_order') {
    // Tri-state: null (undecided), 1 (active), 0 (none).
    if (v === '1' || v === 1 || v === true) return 1;
    if (v === '0' || v === 0 || v === false) return 0;
    return null;
  }
  return v;
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const oppId = params.id;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const { field, value: rawValue } = body;
  if (!field || !PATCHABLE.has(field)) {
    return json({ ok: false, error: `Field "${field}" is not editable` }, 400);
  }

  const before = await one(env.DB, `SELECT * FROM opportunities WHERE id = ?`, [oppId]);
  if (!before) return json({ ok: false, error: 'Not found' }, 404);

  const newValue = coerce(field, rawValue);
  const ts = now();

  // Build diff for audit
  const changes = {};
  if (before[field] !== newValue) {
    changes[field] = { from: before[field], to: newValue };
  }

  try {
    await batch(env.DB, [
      stmt(env.DB, `UPDATE opportunities SET ${field} = ?, updated_at = ? WHERE id = ?`, [newValue, ts, oppId]),
      auditStmt(env.DB, {
        entityType: 'opportunity',
        entityId: oppId,
        eventType: 'updated',
        user,
        summary: `Updated ${field}`,
        changes,
      }),
    ]);
  } catch (e) {
    return json({ ok: false, error: String(e.message ?? e) }, 500);
  }

  return json({ ok: true, field, value: newValue });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
