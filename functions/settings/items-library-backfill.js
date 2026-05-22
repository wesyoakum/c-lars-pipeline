// functions/settings/items-library-backfill.js
//
// POST /settings/items-library-backfill
//
// One-time backfill: populates items_library from all existing
// quote_lines. Admin-only. Safe to re-run (upserts by part_number
// or title match).

import { hasRole } from '../lib/auth.js';
import { backfillLibrary } from '../lib/items-library.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestPost(context) {
  const { env, data } = context;
  const user = data?.user;
  if (!user || !hasRole(user, 'admin')) return json({ error: 'admin only' }, 403);

  const result = await backfillLibrary(env.DB);
  return json({ ok: true, ...result });
}
