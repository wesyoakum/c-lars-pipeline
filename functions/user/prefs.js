// functions/user/prefs.js
//
// PATCH /user/prefs
//
// Partial-update the current user's display preferences (the toggles
// in the gear-icon settings popup in the header). Any subset of:
//
//   {
//     show_alias:   0 | 1 | boolean,
//     group_rollup: 0 | 1 | boolean,
//   }
//
// Both columns are NOT NULL DEFAULT 0 (migration 0034). The endpoint
// only updates the keys present in the payload, so the popup can
// PATCH a single toggle change without clobbering the other one.
//
// Returns 204 on success — the popup reloads the page to pick up the
// new prefs server-side, so we don't need to echo state back.

import { run } from '../lib/db.js';
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

function toFlag(v) {
  if (v === true || v === 1 || v === '1' || v === 'on' || v === 'true') return 1;
  if (v === false || v === 0 || v === '0' || v === 'off' || v === 'false') return 0;
  return null;
}

export async function onRequestPatch(context) {
  const { env, request, data } = context;
  const user = data?.user;
  if (!user || !user.id) return json({ ok: false, error: 'unauthenticated' }, 401);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON.' }, 400);
  }

  const sets = [];
  const params = [];

  if ('show_alias' in payload) {
    const f = toFlag(payload.show_alias);
    if (f === null) return json({ ok: false, error: 'show_alias must be boolean.' }, 400);
    sets.push('show_alias = ?');
    params.push(f);
  }

  if ('group_rollup' in payload) {
    const f = toFlag(payload.group_rollup);
    if (f === null) return json({ ok: false, error: 'group_rollup must be boolean.' }, 400);
    sets.push('group_rollup = ?');
    params.push(f);
  }

  if (sets.length === 0) {
    return json({ ok: false, error: 'No recognised prefs in payload.' }, 400);
  }

  sets.push('updated_at = ?');
  params.push(now());
  params.push(user.id);

  await run(env.DB, `UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);

  return new Response(null, { status: 204 });
}
