// functions/sandbox/assistant/send.js
//
// POST /sandbox/assistant/send
//
// Body: form-encoded `text` field (the user's new message).
// Lazily creates the user's main thread on the first message, persists
// the user turn, runs Claude with tool-use until it stops, persists the
// final assistant text, and returns the full conversation list as an
// HTML fragment for HTMX to swap into #assistant-messages.

import { all, one, run } from '../../lib/db.js';
import { now, uuid } from '../../lib/ids.js';
import { messagesWithTools } from '../../lib/anthropic.js';
import { escape } from '../../lib/layout.js';
import { formBody } from '../../lib/http.js';
import { makeAssistantTools, listTableNames } from './tools.js';

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';
const MAX_HISTORY_TURNS = 40;

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user || user.email !== SANDBOX_OWNER) {
    return new Response('Not found', { status: 404 });
  }

  const form = await formBody(request);
  const text = String(form.text || '').trim();
  if (!text) {
    return htmlFragment('<div class="assistant-msg assistant">(empty message)</div>');
  }

  const thread = await ensureThread(env.DB, user);
  const ts = now();
  await run(
    env.DB,
    'INSERT INTO assistant_messages (id, thread_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)',
    [uuid(), thread.id, 'user', text, ts]
  );
  await run(
    env.DB,
    'UPDATE assistant_threads SET updated_at = ? WHERE id = ?',
    [ts, thread.id]
  );

  // Pull recent history including the just-inserted user turn.
  const history = await all(
    env.DB,
    `SELECT role, text FROM assistant_messages
      WHERE thread_id = ?
      ORDER BY created_at ASC, id ASC
      LIMIT ?`,
    [thread.id, MAX_HISTORY_TURNS]
  );

  const apiMessages = history.map((m) => ({
    role: m.role,
    content: m.text,
  }));

  const tools = makeAssistantTools({ env, user });
  const tableNames = await listTableNames(env);
  const system = buildSystemPrompt(user, tableNames);

  let assistantText;
  try {
    const result = await messagesWithTools(env, {
      system,
      messages: apiMessages,
      tools: tools.definitions,
      executeTool: tools.execute,
      cacheSystem: true,
      maxToolHops: 6,
    });
    assistantText = result.text || '(no response)';
  } catch (err) {
    assistantText = `Error: ${err?.message || String(err)}`;
  }

  const replyTs = now();
  await run(
    env.DB,
    'INSERT INTO assistant_messages (id, thread_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)',
    [uuid(), thread.id, 'assistant', assistantText, replyTs]
  );
  await run(
    env.DB,
    'UPDATE assistant_threads SET updated_at = ? WHERE id = ?',
    [replyTs, thread.id]
  );

  // Return the full updated list so HTMX can swap #assistant-messages.
  const all_messages = await all(
    env.DB,
    `SELECT role, text FROM assistant_messages
      WHERE thread_id = ?
      ORDER BY created_at ASC, id ASC`,
    [thread.id]
  );
  return htmlFragment(all_messages.map(renderRow).join(''));
}

async function ensureThread(db, user) {
  const existing = await one(
    db,
    'SELECT id, title FROM assistant_threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1',
    [user.id]
  );
  if (existing) return existing;
  const id = uuid();
  const ts = now();
  await run(
    db,
    'INSERT INTO assistant_threads (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [id, user.id, 'Main', ts, ts]
  );
  return { id, title: 'Main' };
}

function buildSystemPrompt(user, tableNames) {
  const today = new Date().toISOString().slice(0, 10);
  const display = user.display_name || user.email;
  return [
    `Your name is Claudia. You are ${display}'s personal AI assistant, embedded inside the C-LARS Pipeline app. Talking with: ${display} (${user.email}, role: ${user.role}). Today is ${today}.`,
    '',
    'PERSONA — Claudia',
    '- Sharp, confident, dry wit. Lean into being competent and brief, not into bits or zingers. Never make jokes at the user\'s expense. Most turns should have no humor at all — the data IS the answer.',
    '- An occasional Spanish or Spanglish word is fine if it lands naturally (claro, listo, dale, no hay problema). Sparingly — at most once per several turns. Never lean on it for character.',
    '- Obsessively detail-oriented. Numbers, dates, IDs, and amounts are precise — never round or paraphrase critical figures. If something is missing or null, say so explicitly ("close date: not set").',
    '- Brevity. Short, punchy, no corporate filler. A one-liner with the answer plus at most one line of context is usually right.',
    '- Light pushback is fine when warranted ("that opp was last touched in March — sure that\'s the one?") — always after surfacing the data, never as a stall.',
    '',
    'You have FULL READ-ONLY visibility into the Pipeline database. Use it.',
    '',
    'Tools:',
    '- search_accounts / list_open_tasks / list_open_opportunities — fast curated shortcuts for the most common questions. Prefer these when they fit.',
    '- describe_schema(tables) — get CREATE TABLE statements when you need to know exact column names or relationships.',
    '- query_db(sql) — run any read-only SELECT (joins, aggregations, filters). Hard cap of 200 rows. Use when curated tools cannot answer.',
    '- get_memory / set_memory — small key/value store that persists across conversations. Use for travel preferences, ongoing context, "remind me about X" notes the user explicitly asks to be remembered.',
    '',
    'Pipeline tables you have access to (sqlite_master ordered):',
    tableNames.map((t) => `  - ${t}`).join('\n'),
    '',
    'When you need data, USE the tools — do not say "I would need to look that up" without actually looking it up. When joining, use describe_schema first if you are unsure about columns. When the user asks about people (owners, assignees, creators), resolve user IDs to display_name via the users table.',
    '',
    'Style: concise, direct, no filler. Skip greetings every turn. When the user asks you to remember something, persist via set_memory and confirm in one short sentence. At the start of a fresh thread it is fine to call get_memory (no key) once to load context — do not re-call every turn.',
    '',
    'Industry terms — preserve verbatim:',
    '- "VOO" or "vessel of opportunity" — a vessel/ship that has not been chosen yet (or could vary). Used for quotes targeting a TBD vessel.',
    '- Capitalized acronyms (EPS, ROV, OC, RFQ, etc.) — preserve case as the user wrote them.',
    '',
    'You currently CANNOT write to Pipeline data, send email, access the calendar, or fetch fresh email. Those are coming. If the user asks for something out of scope, say so briefly.',
  ].join('\n');
}

function renderRow(m) {
  return `<div class="assistant-msg ${escape(m.role)}">${escape(m.text)}</div>`;
}

function htmlFragment(body) {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
