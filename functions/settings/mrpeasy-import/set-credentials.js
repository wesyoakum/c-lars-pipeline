// functions/settings/mrpeasy-import/set-credentials.js
//
// POST /settings/mrpeasy-import/set-credentials
// Body: { api_key, api_secret, api_base? }
//
// Stores the MRPeasy API key + secret in the single-row
// mrpeasy_credentials table, then immediately runs a connection test
// (cheapest authenticated call). On success stamps last_verified_at.
//
// Admin-only. Static Basic-auth creds — no rotation, set once.

import { hasRole } from '../../lib/auth.js';
import { run } from '../../lib/db.js';
import { testConnection, markVerified } from '../../lib/mrpeasy-client.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestPost(context) {
  const { env, request, data } = context;
  const user = data?.user;
  if (!user) return json({ ok: false, error: 'sign_in_required' }, 401);
  if (!hasRole(user, 'admin')) return json({ ok: false, error: 'admin_only' }, 403);

  let body = {};
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const apiKey    = String(body.api_key || '').trim();
  const apiSecret = String(body.api_secret || '').trim();
  const apiBase   = String(body.api_base || '').trim();

  if (!apiKey || !apiSecret) {
    return json({ ok: false, error: 'api_key and api_secret are required' }, 400);
  }

  // Store first so testConnection() (which reads from D1) picks it up.
  await run(env.DB,
    `UPDATE mrpeasy_credentials
        SET api_key = ?, api_secret = ?, api_base = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = 1`,
    [apiKey, apiSecret, apiBase || null]);

  // Verify against the live API.
  let test;
  try {
    test = await testConnection(env);
  } catch (err) {
    return json({
      ok: false,
      saved: true,
      verified: false,
      error: 'Saved, but the connection test threw: ' + String(err.message || err),
    });
  }

  if (!test.ok) {
    let hint = '';
    if (test.status === 401 || test.status === 403) {
      hint = ' — bad api-key/secret, OR the MRPeasy account is not on the Unlimited plan (required for REST API access).';
    } else if (test.status === 429) {
      hint = ' — MRPeasy says another request is already running; wait a moment and re-test.';
    } else if (test.status === 404) {
      hint = ' — endpoint not found; the api_base may be wrong (try the other host).';
    }
    return json({
      ok: false,
      saved: true,
      verified: false,
      status: test.status,
      error: 'Saved, but connection test failed (HTTP ' + test.status + ')' + hint,
      detail: test.detail,
    });
  }

  await markVerified(env);
  return json({
    ok: true,
    saved: true,
    verified: true,
    status: test.status,
    customer_count: test.total,
  });
}
