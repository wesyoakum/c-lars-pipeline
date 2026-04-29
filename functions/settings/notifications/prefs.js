// functions/settings/notifications/prefs.js
//
// POST /settings/notifications/prefs — save the event × channel
// matrix and the daily-digest timing.
//
// The form posts:
//   enabled = '<event_type>|<channel>'    (one per CHECKED checkbox)
//   digest_hour_local = '0'..'23'
//   timezone = 'America/...'
//
// We rebuild the matrix from scratch every save: delete all prior
// rows for this user, insert one row per checked combination. (The
// matrix is small — a couple dozen rows max — so DELETE+INSERT is
// simpler than diff-and-update.)

import { stmt, batch, run } from '../../lib/db.js';
import { now } from '../../lib/ids.js';
import { redirectWithFlash, formBody } from '../../lib/http.js';
import {
  NOTIFICATION_EVENTS,
  NOTIFICATION_CHANNELS,
} from '../../lib/notify-external.js';

const VALID_EVENTS = new Set(Object.values(NOTIFICATION_EVENTS));
const VALID_CHANNELS = new Set(Object.values(NOTIFICATION_CHANNELS));

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user) return redirectWithFlash('/settings/notifications', 'Sign in required.', 'error');

  const input = await formBody(request);

  // Multi-value form fields are returned by formBody as either a
  // string (one value) or an array (multiple). Normalize.
  let enabled = input.enabled;
  if (typeof enabled === 'string') enabled = enabled ? [enabled] : [];
  if (!Array.isArray(enabled)) enabled = [];

  // Build the new matrix: filter / dedupe / sanitize.
  const ts = now();
  const insertRows = [];
  const seen = new Set();
  for (const tok of enabled) {
    const [evt, ch] = String(tok).split('|');
    if (!evt || !ch) continue;
    if (!VALID_EVENTS.has(evt) || !VALID_CHANNELS.has(ch)) continue;
    const k = evt + '|' + ch;
    if (seen.has(k)) continue;
    seen.add(k);
    insertRows.push([user.id, evt, ch, 1, ts]);
  }

  // Daily-digest timing. Hour 0-23, timezone IANA-style string.
  const hourRaw = parseInt(String(input.digest_hour_local || ''), 10);
  const digestHour = Number.isFinite(hourRaw) && hourRaw >= 0 && hourRaw <= 23 ? hourRaw : 4;
  const tz = String(input.timezone || '').trim() || 'America/New_York';

  // Self-action notifications: a single per-user toggle. Form sends
  // 'on' (or unset) for the checkbox; we store 1 / 0.
  const notifySelf = input.notify_self_actions === 'on'
                  || input.notify_self_actions === '1'
                  || input.notify_self_actions === 1
                  ? 1 : 0;

  const stmts = [
    stmt(env.DB,
      `DELETE FROM user_notification_prefs WHERE user_id = ?`,
      [user.id]),
    ...insertRows.map(row => stmt(env.DB,
      `INSERT INTO user_notification_prefs
         (user_id, event_type, channel, enabled, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      row)),
    stmt(env.DB,
      `UPDATE users SET timezone = ?, digest_hour_local = ?, notify_self_actions = ?
        WHERE id = ?`,
      [tz, digestHour, notifySelf, user.id]),
  ];
  await batch(env.DB, stmts);

  return redirectWithFlash('/settings/notifications', 'Notification settings saved.');
}
