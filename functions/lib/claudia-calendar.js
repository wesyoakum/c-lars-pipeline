// functions/lib/claudia-calendar.js
//
// Shared calendar layer used by every Claudia surface that wants
// upcoming-meeting awareness:
//   * sandbox/assistant/tools.js — the get_calendar_events chat tool
//   * sandbox/assistant/welcome-back.js — proactive "next 2 hours" hint
//   * api/cron/claudia-tick.js — brief regen pulls today's calendar
//   * lib/claudia-enrich.js — worker enrichment around an event's time
//
// The user's calendar feeds live in assistant_memory under keys of
// the form "calendar.url.<label>". Multi-source: any number of feeds
// can be configured (work / family / wife / kid_baseball / etc).
//
// On every fetch the .ics text is cached for 5 minutes via
// caches.default so the same feed isn't re-pulled when multiple
// surfaces query in close succession (e.g. welcome-back + brief).
//
// Time zones: ICS DTSTART/DTEND values can be UTC ("...Z"), wall-
// clock with TZID parameter, or "floating" (no zone). We resolve
// them to true UTC ms via Intl.DateTimeFormat — see parseIcsDate.

import { all } from './db.js';

export const CALENDAR_URL_KEY_PREFIX = 'calendar.url.';
export const CALENDAR_CACHE_SECONDS = 300;

export const SETUP_INSTRUCTIONS =
  'No calendar URLs configured yet. To add one: publish or share a calendar that exposes an .ics ' +
  'feed (Outlook web → Settings → Calendar → Shared calendars → "Publish a calendar"; Google ' +
  'Calendar → Settings → secret iCal URL; or any team / sports schedule that gives you an .ics ' +
  'link). Then call set_memory with key "' + CALENDAR_URL_KEY_PREFIX + '<label>" and value = the ' +
  'URL. The label is whatever short, lowercase descriptor you want — e.g. "work", "family", ' +
  '"wife", "son_baseball". Multiple calendars are supported; add as many as you want.';

/**
 * Fetch + parse calendar events for the given user across all (or a
 * subset of) configured calendar.url.* feeds, filtered to the [start,
 * end] window. Returns the same shape the get_calendar_events chat
 * tool returns:
 *   { events, count, window, sources }
 * Or an error envelope:
 *   { error: 'no_calendar_url' | 'unknown_sources' | 'invalid_window', message, ... }
 */
export async function getCalendarEvents(env, user, { start, end, sources } = {}) {
  const rows = await all(
    env.DB,
    "SELECT key, value FROM assistant_memory WHERE user_id = ? AND key LIKE 'calendar.url.%'",
    [user.id]
  );

  const allConfigured = rows
    .map((r) => ({ label: r.key.slice(CALENDAR_URL_KEY_PREFIX.length), url: String(r.value || '').trim() }))
    .filter((s) => /^https?:\/\//i.test(s.url));

  if (allConfigured.length === 0) {
    return { error: 'no_calendar_url', message: SETUP_INSTRUCTIONS };
  }

  let working = allConfigured;
  if (Array.isArray(sources) && sources.length > 0) {
    const wanted = new Set(sources.map((s) => String(s).toLowerCase()));
    working = allConfigured.filter((s) => wanted.has(s.label.toLowerCase()));
    if (working.length === 0) {
      return {
        error: 'unknown_sources',
        message: 'None of the requested sources matched any configured calendar.',
        configured_labels: allConfigured.map((s) => s.label),
      };
    }
  }

  const startMs = start ? Date.parse(start) : Date.now();
  const endMs = end ? Date.parse(end) : startMs + 7 * 86400000;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return { error: 'invalid_window', message: 'start/end could not be parsed, or end < start.' };
  }

  // Fetch + parse each calendar concurrently.
  const fetched = await Promise.all(working.map(async (s) => {
    try {
      const text = await fetchIcsCached(s.url);
      const raw = parseIcs(text);
      const events = raw
        .map(normalizeEvent)
        .filter((e) => e.start_ms != null)
        .filter((e) => e.start_ms < endMs && (e.end_ms ?? e.start_ms) > startMs)
        .map((e) => ({
          source: s.label,
          summary: e.summary,
          start: e.start,
          end: e.end,
          all_day: e.all_day,
          location: e.location || undefined,
          organizer: e.organizer || undefined,
          start_ms: e.start_ms,
        }));
      return { source: s.label, ok: true, events };
    } catch (err) {
      return { source: s.label, ok: false, error: err.message || String(err), events: [] };
    }
  }));

  const merged = fetched
    .flatMap((r) => r.events)
    .sort((a, b) => a.start_ms - b.start_ms)
    .slice(0, 100)
    .map(({ start_ms, ...rest }) => rest); // drop internal sort key

  return {
    events: merged,
    count: merged.length,
    window: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
    sources: fetched.map((r) => ({
      label: r.source,
      ok: r.ok,
      count: r.events.length,
      ...(r.error ? { error: r.error } : {}),
    })),
  };
}

/**
 * Convenience wrapper: fetch all events between `start` and `start + windowHours`
 * and return ONLY the events array (or empty array on any error). Useful
 * for non-tool callers (welcome-back, brief, worker enrichment) that
 * don't want to handle the error envelope shape.
 */
export async function getEventsInWindow(env, user, startMs, endMs) {
  try {
    const result = await getCalendarEvents(env, user, {
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
    });
    if (result?.error) return [];
    return Array.isArray(result?.events) ? result.events : [];
  } catch (err) {
    console.warn('[claudia-calendar] getEventsInWindow failed:', err?.message || err);
    return [];
  }
}

/**
 * The current calendar day in America/Chicago, expressed as UTC ms
 * for [start, end). End is "tomorrow midnight CT" so today's evening
 * events are included.
 */
export function todayCtWindow(now = Date.now()) {
  // Get the YYYY-MM-DD that "now" falls on in CT.
  const ymdFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const today = ymdFmt.format(new Date(now)); // "2026-05-08"
  const tomorrow = ymdFmt.format(new Date(now + 86400000));
  // Convert that wall-clock midnight in CT to true UTC ms via the
  // tzid offset trick (same approach parseIcsDate uses).
  return {
    startMs: ctMidnightToUtcMs(today),
    endMs: ctMidnightToUtcMs(tomorrow),
  };
}

function ctMidnightToUtcMs(ymd) {
  // ymd looks like "2026-05-08". Pretend it's UTC midnight, then
  // adjust by Chicago's offset at THAT moment.
  const [y, m, d] = ymd.split('-').map((n) => parseInt(n, 10));
  const guessUtc = Date.UTC(y, m - 1, d, 0, 0, 0);
  const offset = tzidOffsetMs('America/Chicago', guessUtc);
  return guessUtc - offset;
}

// ─── Internal: ICS fetch + parse ─────────────────────────────────────

async function fetchIcsCached(url) {
  const cache = caches.default;
  const cacheKey = new Request(url, { method: 'GET' });
  let resp = await cache.match(cacheKey);
  if (!resp) {
    const upstream = await fetch(url, { headers: { Accept: 'text/calendar' } });
    if (!upstream.ok) {
      throw new Error(`Calendar fetch failed: ${upstream.status} ${upstream.statusText}`);
    }
    // Re-wrap with our own Cache-Control so the Cache API stores it.
    const body = await upstream.text();
    resp = new Response(body, {
      status: 200,
      headers: {
        'content-type': upstream.headers.get('content-type') || 'text/calendar',
        'cache-control': `public, max-age=${CALENDAR_CACHE_SECONDS}`,
      },
    });
    await cache.put(cacheKey, resp.clone());
  }
  return resp.text();
}

function parseIcs(text) {
  // RFC 5545 line-unfolding: a CRLF followed by a space or tab is a continuation.
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      cur = {};
    } else if (line === 'END:VEVENT') {
      if (cur) events.push(cur);
      cur = null;
    } else if (cur) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const keyPart = line.slice(0, colonIdx);
      const value = line.slice(colonIdx + 1);
      const params = keyPart.split(';');
      const key = params[0];
      // Extract TZID parameter so DTSTART/DTEND can resolve floating
      // wall-clock times (e.g. "20260505T180000" with TZID=America/Chicago)
      // to the correct UTC moment instead of being misinterpreted as
      // server-local (UTC) time. The bug this fixes: 6pm Central gets
      // displayed as 1pm Central because Date.parse on a tz-naive ISO
      // treats it as UTC, then we render in CDT and lose 5 hours.
      let tzid = null;
      for (let i = 1; i < params.length; i++) {
        const p = params[i];
        if (p.startsWith('TZID=')) {
          tzid = p.slice(5);
          break;
        }
      }
      // Don't overwrite repeated keys (e.g. multiple ATTENDEE) — first wins for our needs.
      if (!(key in cur)) cur[key] = value;
      // Stash tzid alongside the value, namespaced so it doesn't collide
      // with another ics property.
      if (tzid && !(`${key}_TZID` in cur)) cur[`${key}_TZID`] = tzid;
    }
  }
  return events;
}

function normalizeEvent(raw) {
  const start = parseIcsDate(raw.DTSTART, raw.DTSTART_TZID);
  const end = parseIcsDate(raw.DTEND, raw.DTEND_TZID);
  return {
    summary: unescapeIcs(raw.SUMMARY || ''),
    location: unescapeIcs(raw.LOCATION || ''),
    organizer: (raw.ORGANIZER || '').replace(/^MAILTO:/i, ''),
    start: start?.iso ?? null,
    end: end?.iso ?? null,
    start_ms: start?.ms ?? null,
    end_ms: end?.ms ?? null,
    all_day: !!start?.allDay,
  };
}

/**
 * For a given UTC moment, return the offset (in ms) that tzid is from
 * UTC at that moment (DST-aware). Used by parseIcsDate to convert
 * wall-clock times in tzid to true UTC.
 */
function tzidOffsetMs(tzid, utcMs) {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(new Date(utcMs));
    const o = {};
    for (const p of parts) if (p.type !== 'literal') o[p.type] = parseInt(p.value, 10);
    if (o.hour === 24) o.hour = 0; // some locales render midnight as 24
    const localAsIfUtcMs = Date.UTC(o.year, o.month - 1, o.day, o.hour, o.minute, o.second);
    return localAsIfUtcMs - utcMs;
  } catch {
    return 0; // unknown tzid → treat as UTC (best effort)
  }
}

function parseIcsDate(s, tzid) {
  if (!s) return null;
  // YYYYMMDDTHHMMSS(Z) — datetime, optionally UTC.
  let m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (m) {
    const isUtc = m[7] === 'Z';
    if (isUtc) {
      const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
      const ms = Date.parse(iso);
      return Number.isFinite(ms) ? { iso, ms, allDay: false } : null;
    }
    // No Z: this is a wall-clock time. If the property had a TZID
    // parameter, convert that wall time in that zone to true UTC.
    // First-pass guess: pretend the wall time IS UTC.
    const guessUtcMs = Date.UTC(
      parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10),
      parseInt(m[4], 10), parseInt(m[5], 10), parseInt(m[6], 10)
    );
    if (!Number.isFinite(guessUtcMs)) return null;
    if (tzid) {
      // Adjust by the tzid offset at that moment so the wall-clock
      // time we parsed lands on the right UTC instant.
      const offset = tzidOffsetMs(tzid, guessUtcMs);
      const trueUtcMs = guessUtcMs - offset;
      return { iso: new Date(trueUtcMs).toISOString(), ms: trueUtcMs, allDay: false };
    }
    // No tzid + no Z = "floating" wall time per RFC. We don't know
    // which zone — fall back to treating as UTC. The existing behavior
    // before this fix did the same thing implicitly; flagging here so
    // future-us can revisit if floating times become a real problem.
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
    return { iso, ms: guessUtcMs, allDay: false };
  }
  // YYYYMMDD — all-day.
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}`;
    const ms = Date.parse(iso + 'T00:00:00Z');
    return Number.isFinite(ms) ? { iso, ms, allDay: true } : null;
  }
  return null;
}

function unescapeIcs(s) {
  return String(s)
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}
