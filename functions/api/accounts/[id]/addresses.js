// functions/api/accounts/[id]/addresses.js
//
// GET  /api/accounts/:id/addresses — JSON list of addresses for an account.
// POST /api/accounts/:id/addresses — Create a new address, returns { id, ... }.

import { all, stmt, batch } from '../../../lib/db.js';
import { uuid, now } from '../../../lib/ids.js';

export async function onRequestGet(context) {
  const { env, params } = context;
  const rows = await all(
    env.DB,
    `SELECT id, kind, label, address, is_default
       FROM account_addresses
      WHERE account_id = ?
      ORDER BY kind, is_default DESC, label`,
    [params.id]
  );
  return json(rows);
}

export async function onRequestPost(context) {
  const { env, params, data, request } = context;
  const accountId = params.id;
  const user = data?.user;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const kind = (body.kind || 'billing').trim();
  const label = (body.label || '').trim();
  const address = (body.address || '').trim();

  if (!address) return json({ error: 'Address is required' }, 400);
  if (!['billing', 'physical'].includes(kind)) return json({ error: 'Invalid kind' }, 400);

  const id = uuid();
  const ts = now();

  await batch(env.DB, [
    stmt(
      env.DB,
      `INSERT INTO account_addresses (id, account_id, kind, label, address, is_default, created_at, updated_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [id, accountId, kind, label || null, address, ts, ts, user?.id ?? null]
    ),
  ]);

  return json({ id, kind, label, address, is_default: 0 });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
