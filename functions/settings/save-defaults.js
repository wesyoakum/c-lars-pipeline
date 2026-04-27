// functions/settings/save-defaults.js
//
// POST /settings/save-defaults
//
// Admin-only. Captures the admin's current working state as the
// "new user starts here" baseline in site_prefs:
//
//   * Three display toggles (show_alias, group_rollup, active_only) —
//     read fresh from the admin's users row.
//
//   * list_table_defaults — a JSON blob keyed by list-table storageKey
//     (e.g. "pipeline.quotes.v1"). Captures per-column filters, sort, column
//     visibility / order / widths. Since this state lives in the
//     admin's browser localStorage, the client uploads it in the
//     request body as `{ list_table_defaults: { … } }`. Passing null or
//     omitting the field leaves the site_prefs column untouched.
//
// Migration 0039 added the list_table_defaults column on site_prefs +
// list_table_prefs on users.
//
// Returns 204 — the Settings page shows an alert on success.

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
  const { env, data, request } = context;
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

  // list_table_defaults comes from the browser's localStorage. An
  // empty body (or a non-JSON body) is fine — that branch just skips
  // updating the column. Validate the shape enough to not store
  // obvious garbage: must be a plain object whose keys look like
  // storageKeys ("pipeline.*") and whose values are plain objects.
  let listTableDefaultsJson = undefined;  // undefined = leave column alone
  let hasBody = false;
  try {
    const body = await request.json();
    if (body && typeof body === 'object') {
      hasBody = true;
      const blob = body.list_table_defaults;
      if (blob === null) {
        listTableDefaultsJson = null;  // explicit clear
      } else if (blob && typeof blob === 'object' && !Array.isArray(blob)) {
        const clean = {};
        Object.keys(blob).forEach((k) => {
          if (typeof k !== 'string' || !k.startsWith('pipeline.')) return;
          const v = blob[k];
          if (v && typeof v === 'object' && !Array.isArray(v)) clean[k] = v;
        });
        listTableDefaultsJson = Object.keys(clean).length ? JSON.stringify(clean) : null;
      }
    }
  } catch (_) {
    // no body / not JSON — skip the list_table_defaults write
  }

  const ts = now();
  if (listTableDefaultsJson === undefined) {
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
        ts,
        user.id,
      ]
    );
  } else {
    await run(
      env.DB,
      `UPDATE site_prefs
       SET show_alias = ?, group_rollup = ?, active_only = ?,
           list_table_defaults = ?,
           updated_at = ?, updated_by = ?
       WHERE id = 1`,
      [
        current.show_alias ? 1 : 0,
        current.group_rollup ? 1 : 0,
        current.active_only ? 1 : 0,
        listTableDefaultsJson,
        ts,
        user.id,
      ]
    );
  }

  return new Response(null, { status: 204 });
}
