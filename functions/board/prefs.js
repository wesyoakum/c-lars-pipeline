// functions/board/prefs.js
//
// PATCH /board/prefs
//
// Partial-update the current user's sidebar preferences. Any subset of:
//   {
//     module_order:     ['my_tasks','my_notes','shared','mentions'],
//     module_collapsed: { my_tasks: false, my_notes: true, ... },
//     hidden_until:     ISO-8601 | null
//   }
//
// Hidden_until uses a "tomorrow 8am" preset on the client — caller
// passes the computed timestamp; the server is permissive and accepts
// any ISO-8601 string or null.

import { savePrefs } from '../lib/board.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
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

  const patch = {};

  if (Array.isArray(payload.module_order)) {
    // Accept the ordering as-is but filter to known keys so a stale
    // client can't poison the record.
    const known = ['my_tasks', 'my_notes', 'shared', 'mentions'];
    const filtered = payload.module_order.filter((k) => known.indexOf(k) >= 0);
    // Ensure all known modules are present — append any missing.
    for (const k of known) {
      if (filtered.indexOf(k) < 0) filtered.push(k);
    }
    patch.module_order = filtered;
  }

  if (payload.module_collapsed && typeof payload.module_collapsed === 'object') {
    patch.module_collapsed = {};
    for (const [k, v] of Object.entries(payload.module_collapsed)) {
      patch.module_collapsed[k] = !!v;
    }
  }

  if ('hidden_until' in payload) {
    const v = payload.hidden_until;
    if (v === null) {
      patch.hidden_until = null;
    } else if (typeof v === 'string') {
      const d = new Date(v);
      if (isNaN(d.getTime())) return json({ ok: false, error: 'Invalid hidden_until.' }, 400);
      patch.hidden_until = d.toISOString();
    }
  }

  const saved = await savePrefs(env.DB, user.id, patch);
  return json({ ok: true, prefs: saved });
}
