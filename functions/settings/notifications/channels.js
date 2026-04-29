// functions/settings/notifications/channels.js
//
// POST /settings/notifications/channels — add a new channel for the
// current user. Body fields: channel ('teams' | 'email'), target.
//
// Email-target validation is loose (email-shaped). Teams-target must
// look like an Outlook / Teams webhook URL. We don't try to verify
// the URL is reachable here — that's what the per-row Test button is
// for (separate route).

import { run } from '../../lib/db.js';
import { uuid, now } from '../../lib/ids.js';
import { redirectWithFlash, formBody } from '../../lib/http.js';

const ALLOWED_CHANNELS = new Set(['teams', 'email']);

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user) return redirectWithFlash('/settings/notifications', 'Sign in required.', 'error');

  const input = await formBody(request);
  const channel = String(input.channel || '').trim().toLowerCase();
  let target = String(input.target || '').trim();

  if (!ALLOWED_CHANNELS.has(channel)) {
    return redirectWithFlash('/settings/notifications', 'Invalid channel.', 'error');
  }

  // Email defaults to the user's account address when blank.
  if (channel === 'email' && !target) target = user.email || '';

  if (!target) {
    return redirectWithFlash('/settings/notifications', 'Target is required.', 'error');
  }

  // Light validation per channel.
  if (channel === 'teams') {
    if (!/^https:\/\/[^\s]+$/i.test(target)) {
      return redirectWithFlash('/settings/notifications',
        'Teams target should be the incoming-webhook URL (https://…).', 'error');
    }
  }
  if (channel === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) {
      return redirectWithFlash('/settings/notifications',
        'Email target doesn\'t look like an email address.', 'error');
    }
  }

  const ts = now();
  await run(env.DB,
    `INSERT INTO user_notification_channels
       (id, user_id, channel, target, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
    [uuid(), user.id, channel, target, ts, ts]);

  return redirectWithFlash('/settings/notifications', 'Channel added.');
}
