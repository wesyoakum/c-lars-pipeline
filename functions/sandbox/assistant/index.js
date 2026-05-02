// functions/sandbox/assistant/index.js
//
// GET /sandbox/assistant
//
// Phase 1 chat UI for the personal AI assistant. Wes-only — same email
// allowlist as the rest of /sandbox. Shows the user's single persisted
// thread (lazy-created on first send) and a textarea form. Submits via
// HTMX POST to /sandbox/assistant/send which returns just the updated
// conversation list for an in-place swap (no full reload).

import { all, one } from '../../lib/db.js';
import { layout, html, escape, htmlResponse, subnavTabs } from '../../lib/layout.js';

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';

export async function onRequestGet(context) {
  const { env, data } = context;
  const user = data?.user;
  if (!user || user.email !== SANDBOX_OWNER) {
    return new Response('Not found', { status: 404 });
  }

  const thread = await one(
    env.DB,
    'SELECT id, title FROM assistant_threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1',
    [user.id]
  );

  const messages = thread
    ? await all(
        env.DB,
        `SELECT id, role, text, created_at
           FROM assistant_messages
          WHERE thread_id = ?
          ORDER BY created_at ASC, id ASC`,
        [thread.id]
      )
    : [];

  // Surface up to 5 non-dismissed observations from the last 24 hours,
  // newest first. The hourly cron writes into claudia_observations;
  // this panel is how Wes sees the output.
  const observations = await all(
    env.DB,
    `SELECT id, body, created_at
       FROM claudia_observations
      WHERE user_id = ?
        AND dismissed_at IS NULL
        AND created_at > datetime('now', '-24 hours')
      ORDER BY created_at DESC
      LIMIT 5`,
    [user.id]
  );

  const tabs = subnavTabs(
    [
      { href: '/sandbox', label: 'Flow Chart' },
      { href: '/sandbox/assistant', label: 'Claudia' },
    ],
    '/sandbox/assistant'
  );

  const body = html`
    <style>
      .assistant-wrap {
        max-width: 880px; margin: 0 auto; padding: 1rem;
        display: flex; flex-direction: column;
        height: calc(100vh - 160px); min-height: 480px;
      }
      .assistant-messages {
        flex: 1; overflow-y: auto; padding: 0.5rem 0;
        display: flex; flex-direction: column; gap: 0.75rem;
      }
      .assistant-empty {
        margin: auto; color: #666; font-style: italic; text-align: center;
        max-width: 420px; line-height: 1.6;
      }
      .assistant-msg {
        max-width: 80%; padding: 0.6rem 0.85rem; border-radius: 10px;
        line-height: 1.45; white-space: pre-wrap; word-wrap: break-word;
        font-size: 14px;
      }
      .assistant-msg.user {
        align-self: flex-end; background: #2566ff; color: #fff;
        border-bottom-right-radius: 2px;
      }
      .assistant-msg.assistant {
        align-self: flex-start; background: #f1f3f7; color: #1a1a22;
        border-bottom-left-radius: 2px;
      }
      .assistant-msg-meta {
        font-size: 11px; color: #888; margin-top: 4px;
      }
      .assistant-form {
        display: flex; gap: 0.5rem; align-items: flex-end;
        padding-top: 0.75rem; border-top: 1px solid #e5e7eb;
      }
      .assistant-form textarea {
        flex: 1; resize: none; min-height: 44px; max-height: 180px;
        padding: 10px 12px; border: 1px solid #d0d0d5; border-radius: 8px;
        font: inherit; font-size: 14px; line-height: 1.4;
      }
      .assistant-form textarea:focus { outline: 2px solid #2566ff; outline-offset: -1px; border-color: #2566ff; }
      .assistant-form button {
        padding: 10px 18px; background: #2566ff; color: #fff; border: 0;
        border-radius: 8px; font-size: 14px; cursor: pointer; font-weight: 500;
      }
      .assistant-form button:hover { background: #1245cc; }
      .assistant-form button:disabled { opacity: 0.6; cursor: wait; }
      .assistant-pending {
        align-self: flex-start; background: #f1f3f7; color: #888;
        padding: 0.6rem 0.85rem; border-radius: 10px; font-style: italic;
        font-size: 14px;
      }
      .htmx-request .assistant-pending { display: block; }
      .assistant-pending { display: none; }
      .claudia-obs-panel {
        max-width: 880px; margin: 0.75rem auto 0; padding: 0 1rem;
        display: flex; flex-direction: column; gap: 0.5rem;
      }
      .claudia-obs {
        display: flex; gap: 0.5rem; align-items: flex-start;
        background: #fff7e6; border: 1px solid #facc8a; border-radius: 8px;
        padding: 0.55rem 0.75rem; font-size: 13px; line-height: 1.45;
        color: #4a3a1a;
      }
      .claudia-obs-body { flex: 1; white-space: pre-wrap; word-wrap: break-word; }
      .claudia-obs-meta { font-size: 11px; color: #8a6f3a; margin-bottom: 2px; }
      .claudia-obs-dismiss {
        background: transparent; border: 0; color: #8a6f3a; cursor: pointer;
        font-size: 16px; line-height: 1; padding: 2px 6px; border-radius: 4px;
        flex-shrink: 0;
      }
      .claudia-obs-dismiss:hover { background: rgba(0,0,0,0.06); color: #4a3a1a; }
    </style>
    ${tabs}
    ${observations.length > 0 ? html`
      <div id="claudia-obs-panel" class="claudia-obs-panel">
        ${observations.map(renderObservation)}
      </div>
    ` : ''}
    <div class="assistant-wrap">
      <div id="assistant-messages" class="assistant-messages">
        ${messages.length === 0
          ? html`<div class="assistant-empty">
              <strong>Claudia</strong> — your personal Pipeline assistant. Read-only access to
              every account, opportunity, task, quote, contact, and the rest of the schema.
              Ask about your funnel, your next due task, who owns what — or tell me something
              to remember (travel prefs, ongoing context, "remind me about X").
            </div>`
          : messages.map(renderMessage)}
      </div>
      <form
        class="assistant-form"
        hx-post="/sandbox/assistant/send"
        hx-target="#assistant-messages"
        hx-swap="innerHTML"
        hx-disabled-elt="find textarea, find button"
        hx-on::after-request="if(event.detail.successful){ this.querySelector('textarea').value=''; this.querySelector('textarea').focus(); document.getElementById('assistant-messages').scrollTop = 999999; }"
      >
        <textarea
          name="text"
          placeholder="Message..."
          rows="1"
          required
          autofocus
          onkeydown="if(event.key==='Enter' && !event.shiftKey){ event.preventDefault(); this.form.requestSubmit(); }"
        ></textarea>
        <button type="submit">Send</button>
      </form>
    </div>
    <script>
      // Auto-grow textarea up to its max-height.
      (function () {
        const ta = document.querySelector('.assistant-form textarea');
        if (!ta) return;
        const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 180) + 'px'; };
        ta.addEventListener('input', grow);
        // Scroll to bottom on initial load.
        const list = document.getElementById('assistant-messages');
        if (list) list.scrollTop = list.scrollHeight;
      })();
    </script>
  `;

  return htmlResponse(layout('Claudia', body, { user, activeNav: '/sandbox' }));
}

function renderMessage(m) {
  return html`<div class="assistant-msg ${m.role}">${escape(m.text)}</div>`;
}

function renderObservation(o) {
  const when = formatRelative(o.created_at);
  return html`
    <div class="claudia-obs" id="claudia-obs-${escape(o.id)}">
      <div class="claudia-obs-body">
        <div class="claudia-obs-meta">${escape(when)}</div>
        ${escape(o.body)}
      </div>
      <button
        type="button"
        class="claudia-obs-dismiss"
        title="Dismiss"
        aria-label="Dismiss observation"
        hx-post="/sandbox/assistant/dismiss-observation?id=${encodeURIComponent(o.id)}"
        hx-target="#claudia-obs-${escape(o.id)}"
        hx-swap="outerHTML"
      >×</button>
    </div>
  `;
}

function formatRelative(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const diffMin = Math.round((Date.now() - ms) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  return new Date(ms).toLocaleString();
}

// Exported so send.js can reuse the exact same row markup when returning
// the swap fragment.
export const renderMessageRow = renderMessage;
