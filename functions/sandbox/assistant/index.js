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
import { layout, html, escape, htmlResponse, raw, subnavTabs } from '../../lib/layout.js';

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';

// Stylized brain + neural-circuit icon used for both the empty-state
// intro and the optimistic typing indicator (where the three circuit
// nodes are CSS-animated via .claudia-node-{1,2,3}).
const CLAUDIA_ICON_SVG = `<svg class="claudia-icon" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M24 11 C 14 11, 6 19, 6 28 C 2 30, 2 38, 6 41 C 5 47, 10 53, 17 53 C 18 56, 22 58, 26 56 C 28 58, 33 57, 33 53 L 33 16 C 33 13, 30 11, 27 11 L 24 11 Z" fill="currentColor"/>
  <g fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round">
    <path d="M14 22 Q 22 20, 28 23"/>
    <path d="M10 32 Q 18 32, 28 32"/>
    <path d="M14 42 Q 22 44, 28 41"/>
  </g>
  <g stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M33 22 H46"/>
    <path d="M33 32 H48"/>
    <path d="M33 42 H40 V50 H46"/>
  </g>
  <circle class="claudia-node claudia-node-1" cx="50" cy="22" r="3.5" fill="currentColor"/>
  <circle class="claudia-node claudia-node-2" cx="52" cy="32" r="3"   fill="#fff" stroke="currentColor" stroke-width="3"/>
  <circle class="claudia-node claudia-node-3" cx="50" cy="50" r="3.5" fill="currentColor"/>
</svg>`;

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
      .claudia-icon {
        width: 28px; height: 28px;
        color: #2566ff;
        flex-shrink: 0;
      }
      .claudia-icon-lg { width: 56px; height: 56px; }
      .assistant-typing {
        align-self: flex-start;
        display: inline-flex; align-items: center;
        background: transparent;
        padding: 0.4rem 0.5rem;
      }
      /* Animate the three circuit nodes inside the icon when it lives
         in a typing indicator. transform-box keeps SVG transforms
         centered on each node's own bounding box. */
      .assistant-typing .claudia-node {
        transform-box: fill-box;
        transform-origin: center;
        animation: claudia-node-pulse 1.4s infinite ease-in-out both;
      }
      .assistant-typing .claudia-node-1 { animation-delay: 0s; }
      .assistant-typing .claudia-node-2 { animation-delay: 0.2s; }
      .assistant-typing .claudia-node-3 { animation-delay: 0.4s; }
      @keyframes claudia-node-pulse {
        0%, 100% { opacity: 0.45; transform: scale(0.85); }
        50%      { opacity: 1;    transform: scale(1.25); }
      }
      .assistant-empty-icon {
        display: flex; flex-direction: column; align-items: center; gap: 0.6rem;
      }
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
              <div class="assistant-empty-icon">
                ${raw(CLAUDIA_ICON_SVG.replace('claudia-icon"', 'claudia-icon claudia-icon-lg"'))}
                <strong>Claudia</strong>
              </div>
              Your personal Pipeline assistant. Read-only access to every account, opportunity,
              task, quote, contact, and the rest of the schema. Ask about your funnel, your
              next due task, who owns what — or tell me something to remember
              (travel prefs, ongoing context, "remind me about X").
            </div>`
          : messages.map(renderMessage)}
      </div>
      <form
        class="assistant-form"
        hx-post="/sandbox/assistant/send"
        hx-target="#assistant-messages"
        hx-swap="innerHTML"
        hx-disabled-elt="find textarea, find button"
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
      const CLAUDIA_ICON_HTML = ${raw(JSON.stringify(CLAUDIA_ICON_SVG))};
      (function () {
        const form = document.querySelector('.assistant-form');
        if (!form) return;
        const ta = form.querySelector('textarea');
        const list = document.getElementById('assistant-messages');

        // Auto-grow textarea up to its max-height.
        const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 180) + 'px'; };
        ta.addEventListener('input', grow);

        // Initial scroll-to-bottom.
        if (list) list.scrollTop = list.scrollHeight;

        // BEFORE the HTMX request fires: optimistically append the user's
        // message and a typing indicator so the chat feels instant.
        // The server's response replaces #assistant-messages entirely, so
        // both of these get superseded by the canonical content.
        form.addEventListener('htmx:beforeRequest', () => {
          const value = ta.value.trim();
          if (!value || !list) return;

          // Drop the empty-state intro on first send.
          const empty = list.querySelector('.assistant-empty');
          if (empty) empty.remove();

          // Optimistic user bubble.
          const userMsg = document.createElement('div');
          userMsg.className = 'assistant-msg user';
          userMsg.textContent = value;
          list.appendChild(userMsg);

          // Brain-circuit typing indicator (animated via CSS).
          const typing = document.createElement('div');
          typing.className = 'assistant-typing';
          typing.id = 'assistant-typing-indicator';
          typing.innerHTML = CLAUDIA_ICON_HTML;
          list.appendChild(typing);

          // Clear textarea and shrink it back to one row immediately.
          ta.value = '';
          grow();
          list.scrollTop = list.scrollHeight;
        });

        // AFTER the response: refocus and re-scroll. The optimistic bubble
        // and typing indicator are gone because the swap replaced the list.
        form.addEventListener('htmx:afterRequest', (event) => {
          if (event.detail && event.detail.successful) {
            ta.focus();
            if (list) list.scrollTop = list.scrollHeight;
          }
        });
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
