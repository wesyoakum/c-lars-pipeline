// functions/settings/notifications/channels/:id/test.js
//
// POST /settings/notifications/channels/:id/test — fire a test
// notification through the channel and store the outcome on the row
// (last_test_at, last_test_ok). Settings page shows the result.
//
// Phase 7a: until 7b/7c land providers, sendTestNotification returns
// { ok:false, error:'no_provider' }. The settings UI just shows that
// status; no harm done.

import { one, run } from '../../../../lib/db.js';
import { now } from '../../../../lib/ids.js';
import { redirectWithFlash } from '../../../../lib/http.js';
import { sendTestNotification } from '../../../../lib/notify-external.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  if (!user) return redirectWithFlash('/settings/notifications', 'Sign in required.', 'error');

  const ch = await one(env.DB,
    `SELECT id, channel, target FROM user_notification_channels
      WHERE id = ? AND user_id = ?`,
    [params.id, user.id]);
  if (!ch) return redirectWithFlash('/settings/notifications', 'Channel not found.', 'error');

  const result = await sendTestNotification(env, ch.channel, ch.target);
  await run(env.DB,
    `UPDATE user_notification_channels
        SET last_test_at = ?, last_test_ok = ?, updated_at = ?
      WHERE id = ?`,
    [now(), result.ok ? 1 : 0, now(), ch.id]);

  if (result.ok) {
    return redirectWithFlash('/settings/notifications', 'Test sent — check your channel.');
  }
  const err = result.error === 'no_provider'
    ? 'Test skipped: provider not yet wired up (Phase 7b/7c).'
    : 'Test failed: ' + result.error;
  return redirectWithFlash('/settings/notifications', err, 'error');
}
