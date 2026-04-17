// functions/settings/users/[id]/patch.js
//
// POST /settings/users/:id/patch — inline field save (JSON).
//
// Admin-only. Accepts { field, value } and updates a single field on
// the user row. Returns JSON { ok, field, value, error? }.
//
// Editable fields: role, is_active. Role changes are audited so the
// History viewer (batch 9) can show who promoted/demoted whom.

import { one, stmt, batch } from '../../../lib/db.js';
import { auditStmt } from '../../../lib/audit.js';
import { now } from '../../../lib/ids.js';
import { hasRole } from '../../../lib/auth.js';

const PATCHABLE = new Set(['role', 'is_active']);
const VALID_ROLES = new Set(['admin', 'sales', 'service', 'viewer']);

function coerce(field, raw) {
  if (field === 'is_active') {
    if (raw === 'inactive' || raw === 0 || raw === '0' || raw === false || raw === 'false' || raw === 'off') {
      return 0;
    }
    return 1;
  }
  const v = typeof raw === 'string' ? raw.trim() : raw;
  if (v === '' || v === null || v === undefined) return null;
  return v;
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const userId = params.id;

  if (!hasRole(user, 'admin')) {
    return json({ ok: false, error: 'Admin role required' }, 403);
  }

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

  const before = await one(env.DB, `SELECT * FROM users WHERE id = ?`, [userId]);
  if (!before) return json({ ok: false, error: 'Not found' }, 404);

  const newValue = coerce(field, rawValue);

  // role must be one of the four known values.
  if (field === 'role' && !VALID_ROLES.has(newValue)) {
    return json({ ok: false, error: `Unknown role "${newValue}"` }, 400);
  }

  // Refuse to strip the last admin or deactivate yourself — the
  // cheapest way to brick your own app is to demote yourself with no
  // admin successor, so catch it here.
  if (field === 'role' && before.role === 'admin' && newValue !== 'admin') {
    const otherAdmins = await one(
      env.DB,
      `SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?`,
      [userId]
    );
    if ((otherAdmins?.n ?? 0) === 0) {
      return json({ ok: false, error: 'Cannot demote the last active admin.' }, 409);
    }
  }
  if (field === 'is_active' && before.active === 1 && newValue === 0) {
    if (userId === user.id) {
      return json({ ok: false, error: 'Cannot deactivate yourself.' }, 409);
    }
    if (before.role === 'admin') {
      const otherAdmins = await one(
        env.DB,
        `SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?`,
        [userId]
      );
      if ((otherAdmins?.n ?? 0) === 0) {
        return json({ ok: false, error: 'Cannot deactivate the last active admin.' }, 409);
      }
    }
  }

  const dbField = field === 'is_active' ? 'active' : field;
  const beforeValue = before[dbField];
  const changes = {};
  if (beforeValue !== newValue) {
    changes[dbField] = { from: beforeValue, to: newValue };
  }

  const ts = now();
  try {
    await batch(env.DB, [
      stmt(env.DB, `UPDATE users SET ${dbField} = ?, updated_at = ? WHERE id = ?`, [newValue, ts, userId]),
      auditStmt(env.DB, {
        entityType: 'user',
        entityId: userId,
        eventType: 'updated',
        user,
        summary: `Updated ${dbField}`,
        changes,
      }),
    ]);
  } catch (e) {
    return json({ ok: false, error: String(e.message ?? e) }, 500);
  }

  const responseValue =
    field === 'is_active' ? (newValue ? 'active' : 'inactive') : newValue;
  return json({ ok: true, field, value: responseValue });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
