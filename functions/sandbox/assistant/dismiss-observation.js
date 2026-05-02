// functions/sandbox/assistant/dismiss-observation.js
//
// POST /sandbox/assistant/dismiss-observation?id=<observation_id>
//
// HTMX swap target: returns an empty body so the matched outerHTML
// just disappears from the page. Sets dismissed_at on the observation
// (scoped to the current user, Wes-only) so it never re-appears in
// the panel — but stays in the table for audit / future review.

import { run } from '../../lib/db.js';
import { now } from '../../lib/ids.js';

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user || user.email !== SANDBOX_OWNER) {
    return new Response('Not found', { status: 404 });
  }

  const id = new URL(request.url).searchParams.get('id');
  if (!id) {
    return new Response('Missing id', { status: 400 });
  }

  await run(
    env.DB,
    `UPDATE claudia_observations
        SET dismissed_at = ?
      WHERE id = ? AND user_id = ? AND dismissed_at IS NULL`,
    [now(), id, user.id]
  );

  // Empty body — HTMX outerHTML swap removes the observation from the panel.
  return new Response('', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
