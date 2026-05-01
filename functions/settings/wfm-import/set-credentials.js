// functions/settings/wfm-import/set-credentials.js
//
// POST /settings/wfm-import/set-credentials
// Body: { refresh_token: "..." }
//
// Seeds (or updates) the wfm_credentials.refresh_token for the
// single-row config table, then immediately runs an OAuth refresh
// against BlueRock to validate the token and capture the org_id.
// On failure the refresh_token is rolled back so the page can show
// an error.
//
// Admin only. Refresh token is sent in the body — never logged.

import { hasRole } from '../../lib/auth.js';
import { one, run } from '../../lib/db.js';
import { getAccessToken } from '../../lib/wfm-client.js';

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

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const refresh = String(body?.refresh_token || '').trim();
  if (!refresh) return json({ ok: false, error: 'refresh_token_required' }, 400);

  // Snapshot the existing refresh_token so we can roll back on failure.
  const prior = await one(env.DB,
    'SELECT refresh_token FROM wfm_credentials WHERE id = 1');
  const priorToken = prior?.refresh_token || null;

  // Write the new refresh token; clear cached access token so the
  // next getAccessToken() forces a refresh.
  await run(env.DB,
    `UPDATE wfm_credentials
        SET refresh_token = ?, access_token = NULL, access_expires_at = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = 1`,
    [refresh]);

  // Try to use it — this will rotate the refresh token forward and
  // populate org_id from the JWT. If anything fails, restore the prior.
  try {
    const { orgId } = await getAccessToken(env, { force: true });
    return json({ ok: true, org_id: orgId || '' });
  } catch (err) {
    await run(env.DB,
      `UPDATE wfm_credentials
          SET refresh_token = ?, access_token = NULL, access_expires_at = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = 1`,
      [priorToken]);
    return json({ ok: false, error: String(err.message || err) }, 400);
  }
}
