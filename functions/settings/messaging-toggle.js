// functions/settings/messaging-toggle.js
//
// POST /settings/messaging-toggle
//   Body JSON: { enabled: 0 | 1 }
//
// Admin-only. Flips site_prefs.messaging_enabled (migration 0049).
// When 0, the "Message Everyone" sidebar (BOARD_LEFT_MARKUP in
// functions/lib/layout.js) is not rendered, and POST /board/cards
// rejects scope='direct' submissions.
//
// Returns { ok: true, messaging_enabled: 0|1 } on success.

import { run } from '../lib/db.js';
import { now } from '../lib/ids.js';
import { hasRole } from '../lib/auth.js';

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;

  if (!user) return jsonErr('Sign-in required.', 401);
  if (!hasRole(user, 'admin')) return jsonErr('Admin only.', 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonErr('Invalid JSON body.', 400);
  }

  const enabled = body?.enabled ? 1 : 0;

  await run(
    env.DB,
    'UPDATE site_prefs SET messaging_enabled = ?, updated_at = ?, updated_by = ? WHERE id = 1',
    [enabled, now(), user.id]
  );

  return new Response(
    JSON.stringify({ ok: true, messaging_enabled: enabled }),
    { headers: { 'content-type': 'application/json' } }
  );
}

function jsonErr(error, status) {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
