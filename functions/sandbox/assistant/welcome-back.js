// functions/sandbox/assistant/welcome-back.js
//
// POST /sandbox/assistant/welcome-back
//
// Proactive "while you were away" / "while you were looking elsewhere"
// chat message. Three triggers fire this:
//   1. DOMContentLoaded — initial page visit / refresh
//   2. visibilitychange → visible — tab return after being hidden
//   3. 90s polling timer while tab is visible — live updates while
//      the user is sitting on the page
//
// The endpoint queries activity since assistant_threads.last_active_at
// and, if anything is new, calls Opus once to compose a single
// natural-voice "what landed" message. The message is INSERTed as a
// regular assistant_messages row (so it persists in chat history)
// and returned as an HTML fragment the client can append to the
// chat list.
//
// last_active_at is updated on EVERY call (whether or not a message
// was written) so subsequent polls window from "now" — no spam, no
// missed gaps.
//
// Returns:
//   200 + HTML bubble  → there was activity; here's the new message
//   204 No Content     → no activity OR thread doesn't exist yet OR
//                         model errored (we'd rather skip than ship a
//                         placeholder)

import { all, one, run } from '../../lib/db.js';
import { now, uuid } from '../../lib/ids.js';
import { messages } from '../../lib/anthropic.js';
import { COMPANY_CONTEXT, INDUSTRY_TERMS } from '../../lib/claudia-knowledge.js';
import { renderMarkdown } from '../../lib/claudia-markdown.js';
import { escape } from '../../lib/layout.js';

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';
const WELCOMEBACK_MODEL_DEFAULT = 'claude-opus-4-7';

// First-call window cap — when a thread has no last_active_at (new
// column on a pre-existing thread, or brand-new thread), bound the
// look-back to the last 24h so we don't try to summarize weeks of
// activity in one message.
const FIRST_CALL_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function onRequestPost(context) {
  const { env, data } = context;
  const user = data?.user;
  if (!user || user.email !== SANDBOX_OWNER) {
    return new Response('Not found', { status: 404 });
  }

  // Find the user's active thread. Same single-conversation pattern
  // as the chat — most-recently updated wins. If no thread exists yet
  // (brand-new account), no welcome-back fires; the empty-state intro
  // covers that case.
  const thread = await one(
    env.DB,
    `SELECT id, last_active_at, updated_at
       FROM assistant_threads
      WHERE user_id = ?
      ORDER BY updated_at DESC
      LIMIT 1`,
    [user.id]
  );
  if (!thread) {
    return new Response(null, { status: 204 });
  }

  // Compute the since-window. Falls back to 24h-ago for legacy threads
  // that pre-date the last_active_at column.
  let sinceIso = thread.last_active_at;
  if (!sinceIso) {
    const fallbackMs = Date.now() - FIRST_CALL_WINDOW_MS;
    const fallbackIso = new Date(fallbackMs).toISOString();
    sinceIso = (thread.updated_at && thread.updated_at > fallbackIso)
      ? thread.updated_at
      : fallbackIso;
  }

  // Pull background activity since sinceIso. Same four streams the
  // chat narration block uses, so the welcome-back covers the same
  // ground without duplicating logic.
  const newUploads = await all(
    env.DB,
    `SELECT id, seq, filename, content_type, retention, category,
            extraction_status, sender_email, sender_name, subject,
            email_date, parent_id, created_at,
            substr(coalesce(full_text, ''), 1, 220) AS preview
       FROM claudia_documents
      WHERE user_id = ?
        AND retention != 'trashed'
        AND created_at > ?
      ORDER BY seq ASC`,
    [user.id, sinceIso]
  );
  const newActions = await all(
    env.DB,
    `SELECT id, title, detail, rationale, quadrant, source_kind,
            source_ref_table, source_ref_id, due_at, created_at
       FROM claudia_actions
      WHERE user_id = ?
        AND status = 'open'
        AND created_at > ?
      ORDER BY created_at ASC`,
    [user.id, sinceIso]
  );
  const newObservations = await all(
    env.DB,
    `SELECT id, body, created_at
       FROM claudia_observations
      WHERE user_id = ?
        AND dismissed_at IS NULL
        AND created_at > ?
      ORDER BY created_at ASC`,
    [user.id, sinceIso]
  );
  const recentWrites = await all(
    env.DB,
    `SELECT id, action, ref_table, ref_id, summary, created_at
       FROM claudia_writes
      WHERE user_id = ?
        AND created_at > ?
        AND undone_at IS NULL
      ORDER BY created_at ASC
      LIMIT 20`,
    [user.id, sinceIso]
  );

  const ts = now();

  // Always advance last_active_at to "now" — this is the cooldown
  // mechanism. Even when no message fires, the next poll will only
  // see activity that lands after THIS moment.
  await run(
    env.DB,
    'UPDATE assistant_threads SET last_active_at = ? WHERE id = ?',
    [ts, thread.id]
  );

  const hasActivity =
    newUploads.length > 0 ||
    newActions.length > 0 ||
    newObservations.length > 0 ||
    recentWrites.length > 0;
  if (!hasActivity) {
    return new Response(null, { status: 204 });
  }

  // Compose a single Claudia-voice message via Opus. Cheap (~$0.02
  // per fire) and the voice match matters — these messages interleave
  // with normal chat replies in the same thread.
  const display = user.display_name || user.email;
  const today = new Date().toISOString().slice(0, 10);

  const system = [
    COMPANY_CONTEXT,
    '',
    INDUSTRY_TERMS,
    '',
    '─────────────────────────────────────────────────────────',
    '',
    `You are Claudia, ${display}'s personal assistant. Today is ${today}. You are writing ONE proactive chat message because new activity occurred while ${display} wasn't typing in the chat — he just opened the page, returned to the tab, OR the polling timer fired while the tab was visible. Tell him what landed, briefly, in your normal chat voice.`,
    '',
    'OUTPUT: just the message text. No JSON, no markdown fences, no surrounding prose. ONE single message.',
    '',
    'VOICE — match the regular chat:',
    '- Casual opener as a REACTION ("ok so —", "real quick —", "honestly —", "oh nice —", "oof,", "yesss —"). Match the opener to what landed.',
    `- NO preamble like "Here's what's new" / "Update for you" / "Catch-up time" — just say what's new.`,
    '- Bubbly + concrete. Cite specific seq numbers, sender names, opp numbers, due dates from the activity data.',
    '- NO emojis inside bullets / numbered rows. Positive emojis (✨ 🎉 🙌) in prose only when something genuinely good lands. NO country flag emojis ever.',
    `- NO corporate-speak ("circle back", "leverage", "deep dive", "touch base").`,
    `- NO pleasantries. When done, stop. Don't say "let me know if you need anything".`,
    `- This is a STATUS UPDATE, not an offer of action. Don't end with "want me to do X?" — ${display} will reply if he wants something.`,
    '',
    'LENGTH:',
    '- Light (1-2 small things): one short sentence. Example: "real quick — caught one obs from the cron tick about opp 25297 stalling."',
    '- Medium (3-6 things across categories): 2-4 sentences plus optional 2-4 tight bullets.',
    '- Heavy (lots of stuff): group by type ("X uploads, Y new Hot rows, Z observations"), keep total under ~8 lines.',
    '',
    'FACT DISCIPLINE — CRITICAL:',
    '- Cite ONLY what is in the activity data below. Do NOT introduce facts (opp numbers, sender names, dates, seq numbers) that are not in the data.',
    '- Do NOT fabricate seq numbers. If the data says seq #57, you can quote #57. Do not write #58 or "the .eml at #62" if no row in the data has those seqs.',
    '- This is your only chance to talk in this turn — there are no tools, no follow-up. Get it right with what is given.',
    '- If multiple new uploads share a parent_id, fold them into the parent\'s narration ("Sherman\'s email plus 6 inline images").',
    '- If 30+ tiny image attachments landed (likely email signatures that slipped past the filter), say so plainly ("a pile of 30 inline signature images") rather than enumerating.',
  ].join('\n');

  const stateBlob = JSON.stringify({
    new_uploads: newUploads,
    new_actions: newActions,
    new_observations: newObservations,
    recent_writes: recentWrites,
    since_iso: sinceIso,
  }, null, 2);

  let body;
  try {
    const result = await messages(env, {
      system,
      user: stateBlob,
      model: env.CLAUDIA_WELCOMEBACK_MODEL || WELCOMEBACK_MODEL_DEFAULT,
      cacheSystem: true,
      maxTokens: 600,
    });
    body = (result.text || '').trim();
  } catch (err) {
    console.error('[welcome-back] model call failed:', err?.message || err);
    return new Response(null, { status: 204 });
  }

  if (!body) {
    return new Response(null, { status: 204 });
  }

  // Persist as a regular assistant message — so it's part of chat
  // history on next render, and so the next chat reply's
  // BACKGROUND ACTIVITY block will window from THIS message and not
  // double-narrate.
  const msgId = uuid();
  await run(
    env.DB,
    'INSERT INTO assistant_messages (id, thread_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)',
    [msgId, thread.id, 'assistant', body, ts]
  );
  await run(
    env.DB,
    'UPDATE assistant_threads SET updated_at = ? WHERE id = ?',
    [ts, thread.id]
  );

  return new Response(renderAssistantBubble(body, ts), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

// Compact version of index.js's renderMessage for the assistant
// bubble — markdown body + per-message copy button + timestamp.
// Inlined here (not imported) so the welcome-back bundle stays small.
const CHAT_TIME_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  hour: 'numeric', minute: '2-digit', hour12: true,
});
const CHAT_TIME_FULL_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  hour: 'numeric', minute: '2-digit', hour12: true,
});
function formatChatTime(iso) {
  const ms = Date.parse(String(iso || ''));
  if (!Number.isFinite(ms)) return '';
  return CHAT_TIME_FMT.format(new Date(ms));
}
function formatChatTimeFull(iso) {
  const ms = Date.parse(String(iso || ''));
  if (!Number.isFinite(ms)) return '';
  return CHAT_TIME_FULL_FMT.format(new Date(ms)) + ' CT';
}
function renderAssistantBubble(text, createdAt) {
  const body = renderMarkdown(text);
  const stamp = formatChatTime(createdAt);
  const stampFull = formatChatTimeFull(createdAt);
  return `<div class="assistant-msg assistant" data-copy-text="${escape(text)}">
    <div class="assistant-msg-body">${body}</div>
    <button type="button" class="assistant-msg-copy" aria-label="Copy message" title="Copy">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
    </button>
    ${stamp ? `<div class="assistant-msg-stamp" title="${escape(stampFull)}">${escape(stamp)}</div>` : ''}
  </div>`;
}
