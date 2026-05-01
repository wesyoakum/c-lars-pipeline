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
import { makeAssistantTools } from './tools.js';

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
  const system = buildSystemPrompt(user);

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

function buildSystemPrompt(user) {
  const today = new Date().toISOString().slice(0, 10);
  const display = user.display_name || user.email;
  return [
    `You are a personal AI assistant inside the C-LARS Pipeline app. You are talking with ${display} (${user.email}, role: ${user.role}). Today is ${today}.`,
    '',
    'You can:',
    '- Search Pipeline accounts (companies the user has relationships with).',
    "- Read the user's open tasks (activities) and open opportunities (deals in flight).",
    '- Read and write a small key/value memory that persists across conversations. Use this for travel preferences, ongoing context, "remind me about X" notes the user explicitly asks to be remembered.',
    '',
    'Style: concise, direct, no filler. Skip greetings on every turn. When the user asks something the tools can answer, USE the tools — do not say "I would need to look that up" without actually looking it up. When the user asks you to remember something, persist it via set_memory and confirm in one short sentence.',
    '',
    'At the start of a fresh conversation thread, it is fine to call get_memory (with no key) once to load context. Do not re-call it every turn.',
    '',
    'Industry terms — preserve verbatim:',
    '- "VOO" or "vessel of opportunity" — a vessel/ship that has not been chosen yet (or could vary). Used for quotes targeting a TBD vessel.',
    '- Capitalized acronyms (EPS, ROV, OC, RFQ, etc.) — preserve case as the user wrote them.',
    '',
    'You currently CANNOT: send email, modify accounts/tasks/opportunities, access the calendar, or fetch fresh email. Those are coming. If the user asks for something out of scope, say so briefly.',
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
