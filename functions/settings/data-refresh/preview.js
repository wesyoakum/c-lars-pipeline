// functions/settings/data-refresh/preview.js
//
// POST /settings/data-refresh/preview — read-only.
//
// Body: { keep_account_ids, keep_opp_ids } — both free-text blobs.
// Response: { ok, plan } where plan is the output of computeRefreshPlan.

import { hasRole } from '../../lib/auth.js';
import { computeRefreshPlan, parseIdList } from '../../lib/data-refresh.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user) return json({ ok: false, error: 'unauthenticated' }, 401);
  if (!hasRole(user, 'admin')) return json({ ok: false, error: 'admin_only' }, 403);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const keepAccountIds = parseIdList(body?.keep_account_ids);
  const keepOppIds = parseIdList(body?.keep_opp_ids);

  try {
    const plan = await computeRefreshPlan(env, { keepAccountIds, keepOppIds });
    return json({ ok: true, plan });
  } catch (err) {
    return json({ ok: false, error: err?.message || String(err) }, 500);
  }
}
