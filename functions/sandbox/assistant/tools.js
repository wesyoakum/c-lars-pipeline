// functions/sandbox/assistant/tools.js
//
// Phase 1 toolset for the Sandbox AI Assistant. Read-only over Pipeline
// data + a small key/value memory the model can read & append-to.
// Designed to grow incrementally — add another tool here, expose it in
// `definitions`, branch on its name in `execute`. No write operations
// over real Pipeline data yet (no creating tasks / accounts / etc.) —
// that's a deliberate Phase-1 boundary.

import { all, one, run } from '../../lib/db.js';
import { now } from '../../lib/ids.js';

/**
 * Build the toolset bound to a particular request (env + acting user).
 * Returns Anthropic-format tool definitions plus an executeTool() that
 * dispatches by name. Pass `executeTool` straight into messagesWithTools().
 */
export function makeAssistantTools({ env, user }) {
  const definitions = [
    {
      name: 'search_accounts',
      description:
        'Fuzzy-search Pipeline accounts (companies / customers) by name or alias. ' +
        'Returns up to 20 matches with id, name, segment, alias, parent_group, is_active. ' +
        'Use when the user mentions a company by name and you need to look it up.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Substring to search for in account name or alias.' },
          include_inactive: { type: 'boolean', description: 'Include inactive accounts. Default false.' },
        },
        required: ['query'],
      },
    },
    {
      name: 'list_open_tasks',
      description:
        "List the user's open tasks (activities of type 'task' with no completed_at). " +
        'Returns id, subject, due_at, account_id, opportunity_id, status, created_at, updated_at. ' +
        'Use when planning the day, surfacing what is due, checking what is in flight, or ' +
        'finding what was recently touched (sort=recently_updated).',
      input_schema: {
        type: 'object',
        properties: {
          due_within_days: {
            type: 'integer',
            description: 'Only return tasks due within this many days from today (inclusive). Omit for all open tasks.',
          },
          limit: { type: 'integer', description: 'Max rows to return. Default 50, hard cap 200.' },
          sort: {
            type: 'string',
            enum: ['due_soonest', 'recently_updated', 'recently_created'],
            description: 'Sort order. Default: due_soonest.',
          },
        },
      },
    },
    {
      name: 'list_open_opportunities',
      description:
        "List the user's open Pipeline opportunities (stage not in ('won','lost','closed')). " +
        'Returns id, number, title, stage, account_id, expected_close_date, estimated_value_usd, ' +
        'created_at, updated_at, stage_entered_at. ' +
        'Use to discuss the funnel, deals at risk, what is closing soon, or what was recently ' +
        'touched (sort=recently_updated).',
      input_schema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'Max rows to return. Default 50, hard cap 200.' },
          stage: { type: 'string', description: 'Optional exact-match stage filter.' },
          sort: {
            type: 'string',
            enum: ['closing_soonest', 'recently_updated', 'recently_created'],
            description: 'Sort order. Default: closing_soonest.',
          },
        },
      },
    },
    {
      name: 'get_memory',
      description:
        'Read from the assistant memory store. With a `key`, returns just that one value (or null if missing). ' +
        'Without a key, returns ALL memory entries for the user as an array of {key, value, updated_at}. ' +
        'Use at the start of a conversation to load context, and any time the user references something prior.',
      input_schema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The memory key to fetch. Omit to list all.' },
        },
      },
    },
    {
      name: 'set_memory',
      description:
        'Write a key/value to the assistant memory store. Upserts (overwrites existing key). ' +
        'Use to remember user preferences (travel airline, dietary, working hours), recurring context ' +
        '(active projects, key relationships), or "remind me about X" notes the user explicitly asks ' +
        'to be remembered. Keep keys short and descriptive (e.g. "travel.airline_pref", "remind.q3_review"). ' +
        'Values can be free-form text up to a few KB.',
      input_schema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Short, descriptive key.' },
          value: { type: 'string', description: 'Free-form value to store.' },
        },
        required: ['key', 'value'],
      },
    },
    {
      name: 'describe_schema',
      description:
        'Introspect the Pipeline database. Pass `tables: ["accounts", "opportunities"]` to get the ' +
        'full CREATE TABLE statement for those tables. Pass an empty/omitted `tables` to just list all ' +
        'table names. Call this before query_db when you need to check column names or see what links ' +
        'to what. The list of table names is also included in your system prompt so you usually do not ' +
        'need to list them — go straight to fetching the schema for the tables you care about.',
      input_schema: {
        type: 'object',
        properties: {
          tables: {
            type: 'array',
            items: { type: 'string' },
            description: 'Specific table names to introspect. Omit/empty to just list all tables.',
          },
        },
      },
    },
    {
      name: 'get_calendar_events',
      description:
        "Fetch upcoming events from the user's Outlook published-calendar feed. Requires the .ics " +
        'URL to be saved in memory under the key "calendar.outlook_ics_url" (via set_memory). ' +
        'Returns up to 100 events overlapping the [start, end] window, sorted by start time. ' +
        'Defaults: start=now, end=start+7 days. Server caches the .ics fetch for 5 minutes per URL, ' +
        'so do not worry about calling this repeatedly. ' +
        'If no URL is set, returns an error explaining how to configure one — pass that on to the user.',
      input_schema: {
        type: 'object',
        properties: {
          start: { type: 'string', description: 'ISO datetime (or date) for the start of the window. Default: now.' },
          end: { type: 'string', description: 'ISO datetime (or date) for the end of the window. Default: start + 7 days.' },
        },
      },
    },
    {
      name: 'query_db',
      description:
        'Run a single read-only SELECT (or WITH ... SELECT) against the Pipeline D1 database. Returns ' +
        'up to 200 rows. Use this for any question the curated tools cannot answer: arbitrary joins, ' +
        'aggregations, filters, recency cuts, or full-table introspection. Rules: ' +
        '(1) one statement only, no semicolons; ' +
        '(2) read-only — INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/REPLACE/ATTACH/DETACH/PRAGMA/VACUUM are blocked; ' +
        '(3) if you do not include LIMIT, 200 is appended; ' +
        "(4) prefer the curated tools (search_accounts / list_open_tasks / list_open_opportunities) when they fit — they're cheaper and pre-scoped to the current user.",
      input_schema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'A single read-only SELECT statement.' },
        },
        required: ['sql'],
      },
    },
  ];

  async function execute(name, input) {
    switch (name) {
      case 'search_accounts':
        return searchAccounts(env, input);
      case 'list_open_tasks':
        return listOpenTasks(env, user, input);
      case 'list_open_opportunities':
        return listOpenOpportunities(env, user, input);
      case 'get_memory':
        return getMemory(env, user, input);
      case 'set_memory':
        return setMemory(env, user, input);
      case 'describe_schema':
        return describeSchema(env, input);
      case 'query_db':
        return queryDb(env, input);
      case 'get_calendar_events':
        return getCalendarEvents(env, user, input);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  return { definitions, execute };
}

/**
 * Returns the list of all user-visible table names. Used by the system
 * prompt so Claudia always knows what tables exist without spending a
 * tool call to list them.
 */
export async function listTableNames(env) {
  const rows = await all(
    env.DB,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  return rows.map((r) => r.name);
}

// ---------- Implementations ----------

async function searchAccounts(env, { query, include_inactive }) {
  const q = String(query || '').trim();
  if (!q) return { rows: [], note: 'Empty query.' };
  const like = `%${q}%`;
  const sql = `
    SELECT id, name, segment, alias, parent_group, is_active
      FROM accounts
     WHERE (name LIKE ? OR alias LIKE ?)
       ${include_inactive ? '' : 'AND is_active = 1'}
     ORDER BY name
     LIMIT 20
  `;
  const rows = await all(env.DB, sql, [like, like]);
  return { rows, count: rows.length };
}

async function listOpenTasks(env, user, { due_within_days, limit, sort } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const params = [user.id];
  let sql = `
    SELECT id, subject, status, due_at, account_id, opportunity_id, type,
           created_at, updated_at
      FROM activities
     WHERE assigned_user_id = ?
       AND completed_at IS NULL
       AND (type = 'task' OR type IS NULL)
  `;
  if (Number.isFinite(due_within_days)) {
    const deadline = new Date(Date.now() + due_within_days * 86400000).toISOString();
    sql += ' AND due_at IS NOT NULL AND due_at <= ?';
    params.push(deadline);
  }
  sql += ` ORDER BY ${orderClauseForTasks(sort)} LIMIT ?`;
  params.push(cap);
  const rows = await all(env.DB, sql, params);
  return { rows, count: rows.length };
}

function orderClauseForTasks(sort) {
  switch (sort) {
    case 'recently_updated': return 'updated_at DESC';
    case 'recently_created': return 'created_at DESC';
    case 'due_soonest':
    default:                 return 'due_at IS NULL, due_at ASC';
  }
}

async function listOpenOpportunities(env, user, { limit, stage, sort } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const params = [user.id, user.id];
  let sql = `
    SELECT id, number, title, stage, account_id, expected_close_date,
           estimated_value_usd, created_at, updated_at, stage_entered_at
      FROM opportunities
     WHERE (owner_user_id = ? OR salesperson_user_id = ?)
       AND stage NOT IN ('won', 'lost', 'closed')
  `;
  if (stage) {
    sql += ' AND stage = ?';
    params.push(stage);
  }
  sql += ` ORDER BY ${orderClauseForOpps(sort)} LIMIT ?`;
  params.push(cap);
  const rows = await all(env.DB, sql, params);
  return { rows, count: rows.length };
}

function orderClauseForOpps(sort) {
  switch (sort) {
    case 'recently_updated': return 'updated_at DESC';
    case 'recently_created': return 'created_at DESC';
    case 'closing_soonest':
    default:                 return 'expected_close_date IS NULL, expected_close_date ASC';
  }
}

async function getMemory(env, user, { key } = {}) {
  if (key) {
    const row = await one(
      env.DB,
      'SELECT key, value, updated_at FROM assistant_memory WHERE user_id = ? AND key = ?',
      [user.id, String(key)]
    );
    return row || { key, value: null };
  }
  const rows = await all(
    env.DB,
    'SELECT key, value, updated_at FROM assistant_memory WHERE user_id = ? ORDER BY updated_at DESC',
    [user.id]
  );
  return { rows, count: rows.length };
}

async function describeSchema(env, { tables } = {}) {
  if (!tables || tables.length === 0) {
    const rows = await all(
      env.DB,
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    return { tables: rows.map((r) => r.name) };
  }
  const placeholders = tables.map(() => '?').join(',');
  const rows = await all(
    env.DB,
    `SELECT name, sql FROM sqlite_master WHERE type='table' AND name IN (${placeholders}) ORDER BY name`,
    tables
  );
  const missing = tables.filter((t) => !rows.find((r) => r.name === t));
  return { tables: rows, missing };
}

const DENIED_KEYWORDS = /\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|truncate)\b/i;

async function queryDb(env, { sql }) {
  let stmt = String(sql || '').trim();
  // Strip a single trailing semicolon if present.
  stmt = stmt.replace(/;\s*$/, '');
  if (!stmt) throw new Error('Empty query.');
  if (stmt.includes(';')) throw new Error('Multi-statement queries are not allowed.');
  if (!/^(select|with)\b/i.test(stmt)) {
    throw new Error('Only SELECT or WITH...SELECT queries are allowed.');
  }
  if (DENIED_KEYWORDS.test(stmt)) {
    throw new Error('Query contains a write/DDL keyword (insert/update/delete/drop/alter/create/replace/attach/detach/pragma/vacuum/reindex/truncate).');
  }
  // Apply a hard row cap if the caller didn't include LIMIT.
  const finalSql = /\blimit\s+\d+/i.test(stmt) ? stmt : `${stmt} LIMIT 200`;
  const rows = await all(env.DB, finalSql);
  return { rows, count: rows.length, sql: finalSql };
}

// ---------- Calendar (Outlook published .ics URL) ----------

const CALENDAR_URL_KEY = 'calendar.outlook_ics_url';
const CALENDAR_CACHE_SECONDS = 300;

async function getCalendarEvents(env, user, { start, end } = {}) {
  const urlRow = await one(
    env.DB,
    'SELECT value FROM assistant_memory WHERE user_id = ? AND key = ?',
    [user.id, CALENDAR_URL_KEY]
  );
  if (!urlRow || !urlRow.value) {
    return {
      error: 'no_calendar_url',
      message:
        'No Outlook calendar URL configured. To set one up: in Outlook web → Settings → Calendar → Shared calendars → Publish a calendar (read-only / "Can view all details"). Copy the ICS link, then call set_memory with key "' +
        CALENDAR_URL_KEY +
        '" and value = the URL. After that I can fetch events.',
    };
  }
  const url = String(urlRow.value).trim();
  if (!/^https?:\/\//i.test(url)) {
    return { error: 'invalid_url', message: 'Stored calendar URL is not http(s).' };
  }

  const startMs = start ? Date.parse(start) : Date.now();
  const endMs = end ? Date.parse(end) : startMs + 7 * 86400000;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return { error: 'invalid_window', message: 'start/end could not be parsed, or end < start.' };
  }

  let icsText;
  try {
    icsText = await fetchIcsCached(url);
  } catch (err) {
    return { error: 'fetch_failed', message: err.message || String(err) };
  }

  const raw = parseIcs(icsText);
  const events = raw
    .map(normalizeEvent)
    .filter((e) => e.start_ms != null)
    .filter((e) => e.start_ms < endMs && (e.end_ms ?? e.start_ms) > startMs)
    .sort((a, b) => a.start_ms - b.start_ms)
    .slice(0, 100)
    .map((e) => ({
      summary: e.summary,
      start: e.start,
      end: e.end,
      all_day: e.all_day,
      location: e.location || undefined,
      organizer: e.organizer || undefined,
    }));

  return {
    events,
    count: events.length,
    window: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
  };
}

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
      const key = keyPart.split(';')[0]; // strip params (e.g. DTSTART;TZID=...)
      // Don't overwrite repeated keys (e.g. multiple ATTENDEE) — first wins for our needs.
      if (!(key in cur)) cur[key] = value;
    }
  }
  return events;
}

function normalizeEvent(raw) {
  const start = parseIcsDate(raw.DTSTART);
  const end = parseIcsDate(raw.DTEND);
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

function parseIcsDate(s) {
  if (!s) return null;
  // YYYYMMDDTHHMMSS(Z) — datetime, optionally UTC.
  let m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ? 'Z' : ''}`;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? { iso, ms, allDay: false } : null;
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

async function setMemory(env, user, { key, value }) {
  const k = String(key || '').trim();
  const v = String(value ?? '');
  if (!k) throw new Error('set_memory requires a non-empty key.');
  const ts = now();
  await run(
    env.DB,
    `INSERT INTO assistant_memory (user_id, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
    [user.id, k, v, ts, ts]
  );
  return { ok: true, key: k, updated_at: ts };
}
