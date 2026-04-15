// functions/notifications/unread.js
//
// GET /notifications/unread
//
// Returns the current user's unread notifications as JSON. Polled by
// every authenticated page via a 30-second interval in the layout's
// Alpine notification store. Used for both the bell-icon badge count
// and the toast stack.
//
// Response shape:
//   { unread: [ { id, type, title, body, link_url, entity_type, entity_id, created_at }, ... ] }
//
// Newest first. Capped at 20 rows — if a user somehow has more than
// 20 unread notifications something has gone wrong and the badge
// number is still accurate (it reflects THIS response's length, not
// the true unread count), but the toast stack is protected from a
// runaway scenario.

import { getUnreadForUser } from '../lib/notify.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Never cache this — we want every poll to hit the database.
      'cache-control': 'no-store',
    },
  });
}

export async function onRequestGet(context) {
  const { env, data } = context;
  const user = data?.user;
  if (!user || !user.id) return json({ unread: [] }, 200);

  const unread = await getUnreadForUser(env.DB, user.id, 20);
  return json({ unread });
}
