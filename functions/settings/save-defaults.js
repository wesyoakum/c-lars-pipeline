// functions/settings/save-defaults.js
//
// POST /settings/save-defaults
//
// Admin-only. Copy the current admin's display-preference columns
// (show_alias, group_rollup, active_only) into the single-row
// site_prefs table. Those values are used by the middleware on
// first-time insert of any future new user, and by the Reset to
// defaults action in the Settings page.
//
// Returns 204 — the Settings page reloads after success.

import { one, run } from '../lib/db.js';
import { now } from '../lib/ids.js';
import { hasRole } from '../lib/auth.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export async function onRequestPost(context) {
  const { env, data } = context;
  const user = data?.user;
  if (!user || !user.id) return json({ ok: false, error: 'unauthenticated' }, 401);
  if (!hasRole(user, 'admin')) {
    return json({ ok: false, error: 'Admin role required.' }, 403);
  }

  // Read the admin's CURRENT prefs rather than trust the in-memory
  // `user` object — the object was resolved by the middleware at the
  // start of the request and could be stale if the same user just
  // toggled a pref in another tab a split second ago.
  const current = await one(
    env.DB,
    'SELECT show_alias, group_rollup, active_only FROM users WHERE id = ?',
    [user.id]
  );
  if (!current) return json({ ok: false, error: 'User row missing.' }, 404);

  await run(
    env.DB,
    `UPDATE site_prefs
     SET show_alias = ?, group_rollup = ?, active_only = ?,
         updated_at = ?, updated_by = ?
     WHERE id = 1`,
    [
      current.show_alias ? 1 : 0,
      current.group_rollup ? 1 : 0,
      current.active_only ? 1 : 0,
      now(),
      user.id,
    ]
  );

  return new Response(null, { status: 204 });
}
