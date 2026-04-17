// functions/user/prefs-reset.js
//
// POST /user/prefs-reset
//
// Copy the site-wide defaults (site_prefs row, seeded in migration
// 0036) onto the current user's prefs columns. Any authenticated user
// can call this; it only ever touches their own row.
//
// Returns 204 — the Settings page reloads after success so server-
// rendered lists pick up the change immediately.

import { one, run } from '../lib/db.js';
import { now } from '../lib/ids.js';

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

  const defaults = (await one(
    env.DB,
    'SELECT show_alias, group_rollup, active_only FROM site_prefs WHERE id = 1'
  )) || { show_alias: 0, group_rollup: 0, active_only: 0 };

  await run(
    env.DB,
    `UPDATE users
     SET show_alias = ?, group_rollup = ?, active_only = ?, updated_at = ?
     WHERE id = ?`,
    [
      defaults.show_alias ? 1 : 0,
      defaults.group_rollup ? 1 : 0,
      defaults.active_only ? 1 : 0,
      now(),
      user.id,
    ]
  );

  return new Response(null, { status: 204 });
}
