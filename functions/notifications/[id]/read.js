// functions/notifications/[id]/read.js
//
// POST /notifications/:id/read
//
// Marks one notification as read. The user_id scope in the UPDATE ensures
// user A can't mark user B's notifications — markRead() returns false
// if no row matched, which maps to a 404.
//
// Called by:
//   1. The toast click handler in the layout's Alpine store
//   2. The /notifications history page when the user clicks an item
//
// Response shape:
//   { ok: true }                     — marked (or was already read)
//   { ok: false, error: '...' }      — unauthenticated, missing id, etc.

import { markRead } from '../../lib/notify.js';

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
  const { env, data, params } = context;
  const user = data?.user;
  if (!user || !user.id) return json({ ok: false, error: 'Unauthenticated' }, 401);

  const id = params?.id;
  if (!id) return json({ ok: false, error: 'Missing id' }, 400);

  // markRead returns true if a row was updated, false if nothing
  // matched (already read, wrong user, unknown id). We don't distinguish
  // "already read" from "not found" — both are terminal states and
  // the client doesn't need to know the difference.
  await markRead(env.DB, user.id, id);
  return json({ ok: true });
}
