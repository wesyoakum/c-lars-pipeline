// functions/library/items/[id]/patch.js
//
// POST /library/items/:id/patch — inline field save (JSON).
//
// Accepts { field, value } and updates a single field on the library item.
// Returns JSON { ok, field, value, error? }.

import { one, stmt, batch } from '../../../lib/db.js';
import { auditStmt, diff } from '../../../lib/audit.js';
import { now } from '../../../lib/ids.js';

// Fields that may be patched inline.
const PATCHABLE = new Set([
  'name', 'description', 'category', 'default_unit',
  'default_price', 'notes', 'active',
]);

function coerce(field, raw) {
  const v = typeof raw === 'string' ? raw.trim() : raw;
  if (v === '' || v === null || v === undefined) {
    // name is required — don't allow blanking
    if (field === 'name') return null;
    return null;
  }
  if (field === 'default_price') {
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  }
  if (field === 'active') {
    // Accept 1/0, true/false, "on"/"off"
    if (v === true || v === 'true' || v === '1' || v === 'on' || v === 1) return 1;
    return 0;
  }
  return v;
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const id = params.id;

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

  const before = await one(env.DB, `SELECT * FROM items_library WHERE id = ?`, [id]);
  if (!before) return json({ ok: false, error: 'Not found' }, 404);

  const newValue = coerce(field, rawValue);

  // Validate name is not empty
  if (field === 'name' && !newValue) {
    return json({ ok: false, error: 'Name is required' }, 400);
  }

  const ts = now();

  // Build diff for audit
  const changes = {};
  if (before[field] !== newValue) {
    changes[field] = { from: before[field], to: newValue };
  }

  try {
    const stmts = [
      stmt(env.DB, `UPDATE items_library SET ${field} = ?, updated_at = ? WHERE id = ?`, [newValue, ts, id]),
    ];
    if (Object.keys(changes).length) {
      stmts.push(
        auditStmt(env.DB, {
          entityType: 'items_library',
          entityId: id,
          eventType: 'updated',
          user,
          summary: `Updated ${field}`,
          changes,
        })
      );
    }
    await batch(env.DB, stmts);
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
