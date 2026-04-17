// functions/user/prefs-reset.js
//
// POST /user/prefs-reset
//
// Copy the site-wide defaults (site_prefs row, seeded in migrations
// 0036 + 0039) onto the current user's prefs columns. Any
// authenticated user can call this; it only ever touches their own
// row.
//
// Covers:
//   * Three display toggles (show_alias, group_rollup, active_only)
//     — flow from migration 0036.
//   * list_table_prefs JSON blob (per-column filters, sort, column
//     visibility / order / widths keyed by list-table storageKey)
//     — flow from migration 0039. Since the working copy of this
//     state also lives in the browser's localStorage, the response
//     body returns the site blob so the Settings page JS can replace
//     the user's localStorage in one swoop before reloading.
//
// Returns 200 with JSON { ok: true, list_table_defaults } so the
// client can refresh localStorage before reloading.

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
    'SELECT show_alias, group_rollup, active_only, list_table_defaults FROM site_prefs WHERE id = 1'
  )) || { show_alias: 0, group_rollup: 0, active_only: 0, list_table_defaults: null };

  await run(
    env.DB,
    `UPDATE users
     SET show_alias = ?, group_rollup = ?, active_only = ?, list_table_prefs = ?,
         updated_at = ?
     WHERE id = ?`,
    [
      defaults.show_alias ? 1 : 0,
      defaults.group_rollup ? 1 : 0,
      defaults.active_only ? 1 : 0,
      defaults.list_table_defaults ?? null,
      now(),
      user.id,
    ]
  );

  // Parse the blob so the client can consume it directly. If the
  // column is NULL or unparseable, hand back null — the client will
  // just wipe localStorage.
  let listTableDefaults = null;
  if (defaults.list_table_defaults) {
    try {
      listTableDefaults = JSON.parse(defaults.list_table_defaults);
    } catch (_) {}
  }

  return json({ ok: true, list_table_defaults: listTableDefaults });
}
