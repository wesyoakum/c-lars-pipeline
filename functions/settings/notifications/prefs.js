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

/**
 * Persist the prefs-form payload (event×channel matrix + digest timing
 * + self-actions toggle) for the given user. Pure data-write — no
 * redirect / flash. Returns { ok, error }.
 *
 * Exported so the /sample handler can call this BEFORE dispatching a
 * sample, matching the user's intuition: clicking Send sample should
 * pick up whatever they just checked, even if they haven't clicked
 * Save changes yet.
 */
export async function saveNotificationPrefs(env, user, input) {
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

  const rawTz = String(input.timezone || '').trim();
  const tz = rawTz || 'America/New_York';
  if (rawTz) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: rawTz });
    } catch (_e) {
      return { ok: false, error: '"' + rawTz + '" is not a valid IANA timezone. Try America/New_York, Europe/London, Asia/Singapore, etc.' };
    }
  }

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

  return { ok: true };
}

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user) return redirectWithFlash('/settings/notifications', 'Sign in required.', 'error');

  const input = await formBody(request);
  const result = await saveNotificationPrefs(env, user, input);
  if (!result.ok) {
    return redirectWithFlash('/settings/notifications', result.error || 'Save failed.', 'error');
  }
  return redirectWithFlash('/settings/notifications', 'Notification settings saved.');
}
