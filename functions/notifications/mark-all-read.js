// functions/notifications/mark-all-read.js
//
// POST /notifications/mark-all-read
//
// Bulk-mark every unread notification for the current user as read.
// Used by the "Mark all read" button on the /notifications history page.
// Redirects back to /notifications with a flash confirmation so the
// page reflects the cleared state without a JS fetch.

import { markAllRead } from '../lib/notify.js';
import { redirectWithFlash } from '../lib/http.js';

export async function onRequestPost(context) {
  const { env, data } = context;
  const user = data?.user;
  if (!user || !user.id) {
    return redirectWithFlash('/notifications', 'Not signed in', 'error');
  }

  const count = await markAllRead(env.DB, user.id);
  const msg = count === 0
    ? 'No unread notifications'
    : `Marked ${count} notification${count === 1 ? '' : 's'} as read`;
  return redirectWithFlash('/notifications', msg, 'success');
}
