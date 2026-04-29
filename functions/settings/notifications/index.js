// functions/settings/notifications/index.js
//
// GET /settings/notifications — per-user notification settings page.
//
// Two sections on one page:
//   1. Channels: list of configured Teams webhook URLs / email
//      addresses. Form to add another. Per-row Test + Delete buttons.
//   2. What to send: the event × channel matrix of toggles. Save
//      All Changes button at the bottom.
//
// Phase 7a — foundation only. Until 7b/7c land providers, the
// "Test" button reports "no provider configured" and the matrix
// settings persist but don't fire anything.

import { all, one } from '../../lib/db.js';
import { layout, htmlResponse, html, escape, raw } from '../../lib/layout.js';
import { readFlash } from '../../lib/http.js';
import { hasRole } from '../../lib/auth.js';
import { settingsSubNav } from '../../lib/settings-subnav.js';
import {
  NOTIFICATION_EVENTS,
  NOTIFICATION_EVENT_LABELS,
  NOTIFICATION_EVENT_DESCRIPTIONS,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_CHANNEL_LABELS,
} from '../../lib/notify-external.js';

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user) {
    return htmlResponse(
      layout('Notifications',
        '<section class="card"><h1>Notifications</h1><p>Sign in required.</p></section>',
        { env: data?.env, activeNav: '/settings' }),
      { status: 401 });
  }

  const url = new URL(request.url);
  const isAdmin = hasRole(user, 'admin');

  // Load current channels
  const channels = await all(env.DB,
    `SELECT id, channel, target, active, last_test_at, last_test_ok
       FROM user_notification_channels
      WHERE user_id = ?
      ORDER BY channel, created_at`,
    [user.id]);

  // Load current prefs matrix
  const prefRows = await all(env.DB,
    `SELECT event_type, channel, enabled
       FROM user_notification_prefs
      WHERE user_id = ?`,
    [user.id]);

  // Build a lookup for the matrix
  const prefMap = {};
  for (const r of prefRows) {
    prefMap[`${r.event_type}|${r.channel}`] = !!r.enabled;
  }

  // Load current digest timing
  const userRow = await one(env.DB,
    `SELECT timezone, digest_hour_local FROM users WHERE id = ?`,
    [user.id]);
  const tz = userRow?.timezone || 'America/New_York';
  const digestHour = userRow?.digest_hour_local ?? 4;

  const eventTypes = Object.values(NOTIFICATION_EVENTS);
  const channelTypes = Object.values(NOTIFICATION_CHANNELS);

  const body = html`
    ${settingsSubNav('notifications', isAdmin)}

    <section class="card">
      <div class="card-header">
        <h1>External notifications</h1>
      </div>
      <p class="muted" style="margin-top:0">
        Get pinged outside the app for the things that matter. The in-app
        bell at the top of every page is always on — these channels add
        on top of it (Teams card, email, etc.).
      </p>

      <h2 style="margin-top:1.25rem">Where to send</h2>
      <p class="muted" style="margin-top:0;font-size:0.85rem">
        Each channel is a destination — a Teams webhook URL or an email
        address. You can have several. Use <strong>Test</strong> to send
        a one-off ping to confirm the wiring is right.
      </p>

      ${channels.length === 0
        ? html`<p class="muted">No channels configured yet — add one below.</p>`
        : html`
          <table class="data" style="margin-top:0.5rem">
            <thead>
              <tr>
                <th>Channel</th>
                <th>Target</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${channels.map(c => html`
                <tr>
                  <td><strong>${escape(NOTIFICATION_CHANNEL_LABELS[c.channel] || c.channel)}</strong></td>
                  <td><code style="font-size:0.85em">${escape(truncate(c.target || '', 50))}</code></td>
                  <td>${c.last_test_at
                    ? html`<small class="muted">tested ${escape(c.last_test_at.slice(0, 16).replace('T', ' '))} —
                            ${c.last_test_ok ? raw('<span style="color:#166534">OK</span>') : raw('<span style="color:#b42318">failed</span>')}</small>`
                    : html`<small class="muted">not tested</small>`}
                  </td>
                  <td>
                    <form method="post" action="/settings/notifications/channels/${escape(c.id)}/test" style="display:inline">
                      <button type="submit" class="btn btn-sm">Test</button>
                    </form>
                    <form method="post" action="/settings/notifications/channels/${escape(c.id)}/delete"
                          style="display:inline"
                          onsubmit="return confirm('Remove this channel?');">
                      <button type="submit" class="btn btn-sm danger">Remove</button>
                    </form>
                  </td>
                </tr>
              `)}
            </tbody>
          </table>
        `}

      <h3 style="margin-top:1.25rem">Add a destination</h3>
      <form method="post" action="/settings/notifications/channels"
            class="stacked"
            style="display:flex;flex-direction:column;gap:0.5rem;max-width:560px">
        <label>
          <span style="display:block;font-size:0.85rem;color:var(--fg-muted)">Type</span>
          <select name="channel" required>
            <option value="teams">Microsoft Teams (incoming webhook)</option>
            <option value="email">Email (coming soon)</option>
          </select>
        </label>
        <label>
          <span style="display:block;font-size:0.85rem;color:var(--fg-muted)">Where it goes</span>
          <input type="text" name="target"
                 placeholder="Teams webhook URL — or an email address"
                 required style="width:100%;font:inherit;padding:0.4rem;border:1px solid var(--border);border-radius:4px">
        </label>
        <p class="muted" style="margin:0;font-size:0.82rem">
          <strong>Teams:</strong> paste the incoming-webhook URL from
          your channel's connector settings (Channel → … → Manage channel →
          Connectors → Incoming Webhook → Configure).<br>
          <strong>Email:</strong> leave blank to use your account email
          (<code>${escape(user.email || '')}</code>), or enter another
          address. Email delivery isn't wired up yet — but you can save
          the destination now and it'll start working once the email
          provider lands.
        </p>
        <div>
          <button type="submit" class="btn btn-sm primary">Add destination</button>
        </div>
      </form>

      <h2 style="margin-top:2rem">What to send</h2>
      <p class="muted" style="margin-top:0">
        Pick which events fire on which channel. Empty rows mean no
        external notification at all — the in-app bell still works.
        For now these fire on every matching event, including things
        you do yourself; a "changes by other people only" toggle is
        on the roadmap.
      </p>

      <form method="post" action="/settings/notifications/prefs">
        <table class="data notif-matrix" style="margin-top:0.5rem">
          <thead>
            <tr>
              <th style="min-width:18rem">Event</th>
              ${channelTypes.map(ch => html`<th style="text-align:center;width:8rem">${escape(NOTIFICATION_CHANNEL_LABELS[ch])}</th>`)}
              <th style="text-align:center;width:8rem">Preview</th>
            </tr>
          </thead>
          <tbody>
            ${eventTypes.map(ev => html`
              <tr>
                <td>
                  <div style="font-weight:600">${escape(NOTIFICATION_EVENT_LABELS[ev] || ev)}</div>
                  ${NOTIFICATION_EVENT_DESCRIPTIONS[ev]
                    ? html`<div class="muted" style="font-size:0.82rem;margin-top:0.1rem">${escape(NOTIFICATION_EVENT_DESCRIPTIONS[ev])}</div>`
                    : ''}
                </td>
                ${channelTypes.map(ch => html`
                  <td style="text-align:center">
                    <input type="checkbox"
                           name="enabled"
                           value="${escape(ev)}|${escape(ch)}"
                           ${prefMap[`${ev}|${ch}`] ? 'checked' : ''}>
                  </td>
                `)}
                <td style="text-align:center">
                  <button type="submit"
                          formaction="/settings/notifications/sample"
                          formnovalidate
                          name="event_type"
                          value="${escape(ev)}"
                          class="btn btn-xs"
                          title="Send a sample of this event through your enabled channels">Send sample</button>
                </td>
              </tr>
            `)}
          </tbody>
        </table>
        <p class="muted" style="font-size:0.82rem;margin-top:0.4rem">
          <strong>Send sample</strong> fires a placeholder version of the
          event through whatever channels you've ticked for that row —
          useful for previewing the card or email layout before any
          real event triggers. Save your channel selections first if
          you've just changed them.
        </p>

        <h3 style="margin-top:1.5rem">Daily digest timing</h3>
        <div style="display:flex;align-items:baseline;gap:0.75rem;flex-wrap:wrap;max-width:560px">
          <label style="flex:1">
            <span style="display:block;font-size:0.85rem;color:var(--fg-muted)">Send at hour (local time)</span>
            <select name="digest_hour_local">
              ${Array.from({ length: 24 }, (_, h) => html`
                <option value="${h}" ${h === digestHour ? 'selected' : ''}>
                  ${h.toString().padStart(2, '0')}:00
                </option>
              `)}
            </select>
          </label>
          <label style="flex:2">
            <span style="display:block;font-size:0.85rem;color:var(--fg-muted)">Your timezone (IANA)</span>
            <input type="text" name="timezone" value="${escape(tz)}"
                   placeholder="America/New_York"
                   style="width:100%;font:inherit;padding:0.4rem;border:1px solid var(--border);border-radius:4px">
          </label>
        </div>
        <p class="muted" style="margin-top:0.4rem;font-size:0.82rem">
          Daily digest is opt-in via the matrix above. The cron tick runs
          hourly UTC and fires at <code>digest_hour_local</code> in your
          timezone (default 04:00 America/New_York).
        </p>

        <div style="margin-top:1rem">
          <button type="submit" class="btn btn-sm primary">Save changes</button>
        </div>
      </form>
    </section>
  `;

  return htmlResponse(layout('Notifications', body, {
    user,
    env: data?.env,
    activeNav: '/settings',
    flash: readFlash(url),
  }));
}

function truncate(s, n) {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
