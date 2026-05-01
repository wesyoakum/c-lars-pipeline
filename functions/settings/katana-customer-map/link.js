// functions/settings/katana-customer-map/link.js
//
// POST /settings/katana-customer-map/link
//
// Body: { account_id: string, katana_customer_id: integer,
//         katana_customer_name: string }
//
// Sets accounts.katana_customer_id and katana_customer_name on the
// given account row. Used by the customer-mapping workbench when the
// admin clicks a suggested-match pill or picks a customer from the
// dropdown.
//
// Idempotent — re-linking the same account to the same Katana
// customer is a no-op (the UPDATE just rewrites identical values).
// Re-linking to a *different* Katana customer overwrites silently
// (the user already saw and accepted the change in the UI).

import { run, one, batch, stmt } from '../../lib/db.js';
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
  const katanaId  = parseInt(body?.katana_customer_id, 10);
  const katanaNm  = String(body?.katana_customer_name || '').trim();

  if (!accountId) return jsonError(400, 'account_id required');
  if (!Number.isFinite(katanaId) || katanaId <= 0) return jsonError(400, 'katana_customer_id must be a positive integer');
  if (!katanaNm) return jsonError(400, 'katana_customer_name required');

  const existing = await one(env.DB,
    `SELECT id, name, katana_customer_id, katana_customer_name
       FROM accounts WHERE id = ?`,
    [accountId]);
  if (!existing) return jsonError(404, 'account not found');

  await batch(env.DB, [
    stmt(env.DB,
      `UPDATE accounts
          SET katana_customer_id   = ?,
              katana_customer_name = ?,
              updated_at           = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
      [katanaId, katanaNm, accountId]),
    auditStmt(env.DB, {
      entityType: 'account',
      entityId: accountId,
      eventType: 'updated',
      user,
      summary: `Linked to Katana customer "${katanaNm}" (#${katanaId})`,
      changes: {
        katana_customer_id:   { from: existing.katana_customer_id || null,    to: katanaId },
        katana_customer_name: { from: existing.katana_customer_name || null, to: katanaNm },
      },
    }),
  ]);

  return jsonOk({
    account_id: accountId,
    katana_customer_id: katanaId,
    katana_customer_name: katanaNm,
  });
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
