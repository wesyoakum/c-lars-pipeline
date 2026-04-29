// functions/settings/notifications/channels/[id]/delete.js
//
// POST /settings/notifications/channels/:id/delete

import { run } from '../../../../lib/db.js';
import { redirectWithFlash } from '../../../../lib/http.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  if (!user) return redirectWithFlash('/settings/notifications', 'Sign in required.', 'error');

  // user_id check ensures user A can't delete user B's channel.
  await run(env.DB,
    `DELETE FROM user_notification_channels WHERE id = ? AND user_id = ?`,
    [params.id, user.id]);

  return redirectWithFlash('/settings/notifications', 'Channel removed.');
}
