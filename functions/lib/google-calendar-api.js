// functions/lib/google-calendar-api.js
//
// Thin wrapper around Google's Calendar v3 REST API for Claudia's
// calendar-write tools. Authenticates via getValidAccessToken — the
// same Gmail OAuth row covers Calendar scopes once Wes reconnects
// (see GMAIL_DEFAULT_SCOPES in lib/gmail-oauth.js).
//
// Calendar API reference:
//   https://developers.google.com/calendar/api/v3/reference
//
// Surface:
//   - listCalendars(env, userId)                                   GET /users/me/calendarList
//   - createEvent(env, userId, calendarId, eventBody)              POST  /calendars/{cid}/events
//   - updateEvent(env, userId, calendarId, eventId, patch)         PATCH /calendars/{cid}/events/{eid}
//   - deleteEvent(env, userId, calendarId, eventId)                DELETE /calendars/{cid}/events/{eid}
//
// Errors propagate from getValidAccessToken (gmail_not_connected /
// refresh_failed) so the caller's gmailGuard catches them. API errors
// throw with a message that includes the Google error body — useful
// when scope is missing ("insufficient authentication scopes" means
// Wes needs to reconnect).

import { getValidAccessToken } from './gmail-oauth.js';

const CAL_API_BASE = 'https://www.googleapis.com/calendar/v3';

async function calFetch(env, userId, method, path, { params, body } = {}) {
  const { accessToken } = await getValidAccessToken(env, userId);
  const url = new URL(CAL_API_BASE + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body != null ? { 'content-type': 'application/json' } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null; // DELETE
  const text = await res.text();
  if (!res.ok) {
    // Surface insufficient-scope errors plainly so Claudia can route
    // Wes to /settings/claudia for a reconnect rather than guessing.
    let detail = text.slice(0, 400);
    let isScope = false;
    try {
      const j = JSON.parse(text);
      const msg = j?.error?.message || '';
      if (/insufficient.*scope/i.test(msg) || /Request had insufficient authentication scopes/i.test(msg)) {
        isScope = true;
      }
      if (msg) detail = msg;
    } catch { /* not JSON, fall through */ }
    const err = new Error(`Calendar API ${res.status} on ${method} ${path}: ${detail}`);
    if (isScope) err.code = 'calendar_scope_missing';
    throw err;
  }
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * List all calendars on the user's calendarList — primary + any
 * shared / subscribed ones. Returns the items array shaped with the
 * fields Claudia needs (id, summary, primary?, accessRole, timeZone).
 */
export async function listCalendars(env, userId) {
  const data = await calFetch(env, userId, 'GET', '/users/me/calendarList', {
    params: { maxResults: 250, minAccessRole: 'reader' },
  });
  const items = Array.isArray(data?.items) ? data.items : [];
  return items.map((c) => ({
    id: c.id,
    summary: c.summary,
    description: c.description || null,
    primary: !!c.primary,
    access_role: c.accessRole,
    time_zone: c.timeZone || null,
    background_color: c.backgroundColor || null,
  }));
}

/**
 * Create an event on a calendar. eventBody follows the Google Calendar
 * Events resource shape (https://developers.google.com/calendar/api/v3/reference/events#resource).
 *
 * Minimum fields: summary + start + end. start/end can be:
 *   { dateTime: "2026-05-09T15:00:00-05:00" }       (timed)
 *   { date: "2026-05-09" }                          (all-day)
 *
 * sendUpdates: 'none' | 'all' | 'externalOnly' — controls whether
 * Google emails attendees on creation. Default 'none' (no blast on
 * Claudia-driven inserts unless the caller explicitly opts in).
 *
 * Returns the full server-shaped event (so the caller can echo the
 * htmlLink and the server-assigned id).
 */
export async function createEvent(env, userId, calendarId, eventBody, { sendUpdates } = {}) {
  const cid = encodeURIComponent(calendarId || 'primary');
  return calFetch(env, userId, 'POST', `/calendars/${cid}/events`, {
    params: sendUpdates ? { sendUpdates } : undefined,
    body: eventBody,
  });
}

/**
 * Patch an existing event. `patch` is a partial Events resource —
 * only the fields you include are changed. Use updateEvent (not
 * replace) so we don't have to re-send unchanged fields.
 */
export async function updateEvent(env, userId, calendarId, eventId, patch, { sendUpdates } = {}) {
  const cid = encodeURIComponent(calendarId || 'primary');
  const eid = encodeURIComponent(eventId);
  return calFetch(env, userId, 'PATCH', `/calendars/${cid}/events/${eid}`, {
    params: sendUpdates ? { sendUpdates } : undefined,
    body: patch,
  });
}

/**
 * Delete an event. Returns null on success (204 No Content). Throws
 * on 404 / 410 (already deleted) — Claudia surfaces those plainly.
 *
 * sendUpdates default 'all' (cancellation emails go out by default —
 * if anyone's on the meeting they should know).
 */
export async function deleteEvent(env, userId, calendarId, eventId, { sendUpdates = 'all' } = {}) {
  const cid = encodeURIComponent(calendarId || 'primary');
  const eid = encodeURIComponent(eventId);
  await calFetch(env, userId, 'DELETE', `/calendars/${cid}/events/${eid}`, {
    params: sendUpdates ? { sendUpdates } : undefined,
  });
  return { ok: true };
}
