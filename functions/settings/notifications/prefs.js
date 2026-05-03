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

import { stmt, batch, run, one } from '../../lib/db.js';
import { now } from '../../lib/ids.js';
import { redirectWithFlash, formBody } from '../../lib/http.js';
import {
  NOTIFICATION_EVENTS,
  NOTIFICATION_CHANNELS,
} from '../../lib/notify-external.js';

const VALID_EVENTS = new Set(Object.values(NOTIFICATION_EVENTS));
const VALID_CHANNELS = new Set(Object.values(NOTIFICATION_CHANNELS));

// Common US (and a few global) timezone abbreviations that users
// type before remembering the IANA-zone form. We map them to the
// region/city IANA name so the digest cron still works.
// CDT vs CST, PDT vs PST, etc. all resolve to the same IANA zone —
// the IANA database handles DST transitions internally based on the
// city, so we don't need separate -DT / -ST entries.
const TZ_ABBREV = {
  EST: 'America/New_York',
  EDT: 'America/New_York',
  CST: 'America/Chicago',
  CDT: 'America/Chicago',
  MST: 'America/Denver',           // most of MST observes DST
  MDT: 'America/Denver',
  PST: 'America/Los_Angeles',
  PDT: 'America/Los_Angeles',
  AKST: 'America/Anchorage',
  AKDT: 'America/Anchorage',
  HST: 'Pacific/Honolulu',
  GMT: 'UTC',
};

function normalizeTimezone(rawTz) {
  if (!rawTz) return { tz: '', valid: true };
  const trimmed = String(rawTz).trim();
  if (!trimmed) return { tz: '', valid: true };
  // Try the abbreviation map first (case-insensitive).
  const upper = trimmed.toUpperCase();
  const mapped = TZ_ABBREV[upper];
  if (mapped) return { tz: mapped, valid: true, mapped: true, original: trimmed };
  // Otherwise validate as IANA via Intl.DateTimeFormat.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
    return { tz: trimmed, valid: true };
  } catch (_e) {
    return { tz: '', valid: false, original: trimmed };
  }
}

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

  // Timezone resolution:
  //   1. Empty → default America/New_York.
  //   2. Common abbreviation (CDT, EST, etc.) → mapped IANA city.
  //   3. Valid IANA name → used as-is.
  //   4. Invalid → DON'T block the save. Fall back to whatever the
  //      user currently has on file (so the rest of the form's
  //      changes still land), and surface the invalid value back to
  //      the caller as a non-fatal warning. Blocking the entire save
  //      on a typo'd tz string was the bug in v0.519.
  const rawTz = String(input.timezone || '').trim();
  let tz = rawTz || 'America/New_York';
  let tzWarning = null;
  let tzNote = null;
  if (rawTz) {
    const norm = normalizeTimezone(rawTz);
    if (norm.valid) {
      tz = norm.tz;
      if (norm.mapped) {
        tzNote = '"' + norm.original + '" is a timezone abbreviation; saved as "' + norm.tz + '" (the IANA region/city name).';
      }
    } else {
      // Invalid → keep the user's existing tz, log a warning.
      const existing = await one(env.DB,
        'SELECT timezone FROM users WHERE id = ?', [user.id]);
      tz = existing?.timezone || 'America/New_York';
      tzWarning = '"' + rawTz + '" is not a valid IANA timezone — kept "' + tz + '". Use a region/city name like America/Chicago, Europe/London, Asia/Singapore, etc.';
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

  return { ok: true, tzWarning, tzNote };
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
  if (result.tzWarning) {
    return redirectWithFlash('/settings/notifications',
      'Settings saved. ' + result.tzWarning, 'warn');
  }
  if (result.tzNote) {
    return redirectWithFlash('/settings/notifications',
      'Settings saved. ' + result.tzNote);
  }
  return redirectWithFlash('/settings/notifications', 'Notification settings saved.');
}
