// functions/settings/katana-customer-map/unlink.js
//
// POST /settings/katana-customer-map/unlink
//
// Body: { account_id: string }
//
// Clears accounts.katana_customer_id and katana_customer_name.
// Doesn't touch Katana — the customer record there is left alone
// (still useful for any sales orders already pushed against it).
// Pipeline simply forgets which Katana customer it was paired to.

import { one, batch, stmt } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { hasRole } from '../../lib/auth.js';

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user) return jsonError(401, 'sign-in required');
  if (!hasRole(user, 'admin')) return jsonError(403, 'admin only');

  let body;
  try { body = await request.json(); }
  catch { return jsonError(400, 'invalid JSON body'); }

  const accountId = String(body?.account_id || '').trim();
  if (!accountId) return jsonError(400, 'account_id required');

  const existing = await one(env.DB,
    `SELECT id, name, katana_customer_id, katana_customer_name
       FROM accounts WHERE id = ?`,
    [accountId]);
  if (!existing) return jsonError(404, 'account not found');
  if (!existing.katana_customer_id) {
    // Already unlinked — return success so the UI stays consistent.
    return jsonOk({ account_id: accountId });
  }

  await batch(env.DB, [
    stmt(env.DB,
      `UPDATE accounts
          SET katana_customer_id   = NULL,
              katana_customer_name = NULL,
              updated_at           = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
      [accountId]),
    auditStmt(env.DB, {
      entityType: 'account',
      entityId: accountId,
      eventType: 'updated',
      user,
      summary: `Unlinked from Katana customer "${existing.katana_customer_name || existing.katana_customer_id}"`,
      changes: {
        katana_customer_id:   { from: existing.katana_customer_id,   to: null },
        katana_customer_name: { from: existing.katana_customer_name, to: null },
      },
    }),
  ]);

  return jsonOk({ account_id: accountId });
}

function jsonOk(obj) {
  return new Response(JSON.stringify({ ok: true, ...obj }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
function jsonError(status, message) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
