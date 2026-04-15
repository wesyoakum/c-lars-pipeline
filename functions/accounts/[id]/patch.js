// functions/accounts/[id]/patch.js
//
// POST /accounts/:id/patch — inline field save (JSON).
//
// Accepts { field, value } and updates a single field on the account.
// Returns JSON { ok, field, value, error? }.

import { one, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { now } from '../../lib/ids.js';

const PATCHABLE = new Set([
  'name', 'alias', 'segment', 'phone', 'website', 'notes', 'owner_user_id',
  'parent_group',
]);

function coerce(field, raw) {
  const v = typeof raw === 'string' ? raw.trim() : raw;
  if (v === '' || v === null || v === undefined) return null;
  return v;
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const accountId = params.id;

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

  // name is required — don't allow blanking it
  if (field === 'name') {
    const trimmed = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (!trimmed) {
      return json({ ok: false, error: 'Name is required' }, 400);
    }
  }

  const before = await one(env.DB, `SELECT * FROM accounts WHERE id = ?`, [accountId]);
  if (!before) return json({ ok: false, error: 'Not found' }, 404);

  const newValue = coerce(field, rawValue);
  const ts = now();

  const changes = {};
  if (before[field] !== newValue) {
    changes[field] = { from: before[field], to: newValue };
  }

  try {
    await batch(env.DB, [
      stmt(env.DB, `UPDATE accounts SET ${field} = ?, updated_at = ? WHERE id = ?`, [newValue, ts, accountId]),
      auditStmt(env.DB, {
        entityType: 'account',
        entityId: accountId,
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
