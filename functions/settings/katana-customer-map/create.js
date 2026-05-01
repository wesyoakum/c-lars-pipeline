// functions/settings/katana-customer-map/create.js
//
// POST /settings/katana-customer-map/create
//
// Body: { account_id: string, katana_name: string }
//
// Creates a new Katana customer via POST /customers, then links it
// to the given Pipeline account. Used by the "+ Create in Katana"
// button on the customer-mapping workbench.
//
// The Katana customer is created minimally — just the name. Phone,
// email, address, etc. are left empty (Katana allows it). The Phase 2c
// push flow will set order-level addresses if needed; mirroring all
// of Pipeline's address data into Katana customer rows is out of
// scope and arguably the wrong direction (Katana customers are
// project labels in C-LARS's setup, not full customer records).

import { one, batch, stmt } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { hasRole } from '../../lib/auth.js';
import { apiPost } from '../../lib/katana-client.js';

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user) return jsonError(401, 'sign-in required');
  if (!hasRole(user, 'admin')) return jsonError(403, 'admin only');

  let body;
  try { body = await request.json(); }
  catch { return jsonError(400, 'invalid JSON body'); }

  const accountId = String(body?.account_id || '').trim();
  const katanaNm  = String(body?.katana_name || '').trim();

  if (!accountId) return jsonError(400, 'account_id required');
  if (!katanaNm)  return jsonError(400, 'katana_name required');
  if (katanaNm.length > 200) return jsonError(400, 'katana_name too long (max 200 chars)');

  const existing = await one(env.DB,
    `SELECT id, name, katana_customer_id, katana_customer_name
       FROM accounts WHERE id = ?`,
    [accountId]);
  if (!existing) return jsonError(404, 'account not found');
  if (existing.katana_customer_id) {
    return jsonError(409, `account is already linked to Katana customer #${existing.katana_customer_id}`);
  }

  // Create in Katana first. If that fails, no DB change has happened
  // yet so we can return cleanly.
  let created;
  try {
    const r = await apiPost(env, '/customers', { name: katanaNm, currency: 'USD' });
    if (!r.ok) {
      return jsonError(502, `Katana rejected create: ${r.status} ${typeof r.body === 'string' ? r.body.slice(0, 200) : JSON.stringify(r.body).slice(0, 200)}`);
    }
    created = r.body;
  } catch (err) {
    return jsonError(502, `Katana create failed: ${String(err && err.message || err)}`);
  }

  const newId = parseInt(created?.id, 10);
  const newName = String(created?.name || katanaNm).trim();
  if (!Number.isFinite(newId) || newId <= 0) {
    return jsonError(502, `Katana create returned no usable id (got ${JSON.stringify(created).slice(0, 200)})`);
  }

  // Now link the Pipeline account.
  await batch(env.DB, [
    stmt(env.DB,
      `UPDATE accounts
          SET katana_customer_id   = ?,
              katana_customer_name = ?,
              updated_at           = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
      [newId, newName, accountId]),
    auditStmt(env.DB, {
      entityType: 'account',
      entityId: accountId,
      eventType: 'updated',
      user,
      summary: `Created Katana customer "${newName}" (#${newId}) and linked it`,
      changes: {
        katana_customer_id:   { from: null, to: newId },
        katana_customer_name: { from: null, to: newName },
      },
    }),
  ]);

  return jsonOk({
    account_id: accountId,
    katana_customer_id: newId,
    katana_customer_name: newName,
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
