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
import {
  renderDocsPanel,
  renderAudioPanel,
  partitionDocs,
} from '../../lib/claudia-documents-render.js';
import { ICON_PAPERCLIP, ICON_MIC } from '../../lib/icons.js';

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

  // Drop-zone documents (newest 30, non-trashed) for the initial render.
  // Preview is bumped to 600 chars so the audio sidebar can show a real
  // transcript snippet; the right docs sidebar doesn't render preview.
  const documents = await all(
    env.DB,
    `SELECT id, filename, content_type, size_bytes, retention,
            extraction_status, extraction_error, created_at,
            substr(coalesce(full_text, ''), 1, 600) AS preview
       FROM claudia_documents
      WHERE user_id = ? AND retention != 'trashed'
      ORDER BY created_at DESC
      LIMIT 30`,
    [user.id]
  );
  const { audio: audioDocs, other: otherDocs } = partitionDocs(documents);

  const tabs = subnavTabs(
    [
      { href: '/sandbox/assistant', label: 'Claudia' },
      { href: '/sandbox', label: 'Flow Chart' },
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
      /* Minimalist scrollbar — same shape as the table scrollbars in
         pipeline.css (.opp-list-hscroll). Applies to the chat messages
         pane and both sidebars. */
      .assistant-messages::-webkit-scrollbar,
      .claudia-side::-webkit-scrollbar { width: 6px; }
      .assistant-messages::-webkit-scrollbar-track,
      .claudia-side::-webkit-scrollbar-track { background: transparent; }
      .assistant-messages::-webkit-scrollbar-thumb,
      .claudia-side::-webkit-scrollbar-thumb {
        background: rgba(0, 0, 0, 0.1);
        border-radius: 3px;
      }
      .assistant-messages::-webkit-scrollbar-thumb:hover,
      .claudia-side::-webkit-scrollbar-thumb:hover {
        background: rgba(0, 0, 0, 0.2);
      }
      .assistant-messages { scrollbar-width: thin; scrollbar-color: rgba(0,0,0,0.1) transparent; }
      .claudia-side       { scrollbar-width: thin; scrollbar-color: rgba(0,0,0,0.1) transparent; }

      /* Floating scroll-to-top / scroll-to-bottom buttons over the
         messages pane. Hidden by default; .visible class toggled by JS
         based on current scroll position. */
      .chat-scroll-jump {
        position: absolute; right: 14px; z-index: 4;
        width: 30px; height: 30px; border-radius: 50%;
        background: rgba(255, 255, 255, 0.92);
        border: 1px solid #d0d0d5; color: #4b5563; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        opacity: 0; pointer-events: none;
        transition: opacity 0.15s ease, transform 0.15s ease;
        box-shadow: 0 1px 4px rgba(0,0,0,0.06);
      }
      .chat-scroll-jump:hover { color: #1a1a22; background: #fff; }
      .chat-scroll-jump.visible { opacity: 1; pointer-events: auto; }
      #chat-scroll-top    { top: 90px; }
      #chat-scroll-bottom { bottom: 90px; }
      .chat-scroll-jump svg { width: 14px; height: 14px; }
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
      /* Auto-fired "[Just uploaded: ...]" trigger — small centered note,
         not a regular user bubble. */
      .assistant-msg.system-trigger {
        align-self: center; background: transparent; color: #94a3b8;
        font-size: 11px; font-style: italic; padding: 2px 8px;
        max-width: none; border-radius: 0;
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
      /* Break out of the global .site-main 1100px max-width so the
         three-column layout can use the full viewport. Scoped to the
         Claudia page — this <style> block only renders here. */
      main.site-main {
        max-width: none !important;
        padding-left: 0 !important;
        padding-right: 0 !important;
      }
      /* ---- Layout: three columns (audio | chat | docs) ---- */
      .assistant-layout {
        display: grid;
        grid-template-columns: 300px minmax(0, 1fr) 300px;
        gap: 1rem;
        max-width: 1500px; margin: 0 auto; padding: 0 1rem;
        align-items: start;
      }
      .assistant-layout .assistant-wrap {
        min-width: 0; padding: 1rem 0; max-width: none;
      }
      .claudia-side {
        position: sticky; top: 16px;
        align-self: start;
        max-height: calc(100vh - 100px);
        overflow-y: auto;
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        padding: 0.6rem 0.7rem;
        margin-top: 1rem;
      }
      .claudia-side h3 {
        margin: 0 0 0.5rem 0; font-size: 11px; font-weight: 600;
        text-transform: uppercase; letter-spacing: 0.05em; color: #64748b;
      }
      .claudia-side-empty {
        font-size: 12px; color: #94a3b8; font-style: italic; line-height: 1.5;
      }
      @media (max-width: 1100px) {
        /* Tablet: stack docs on top, hide audio sidebar (rare on the
           road) — user can still find recordings via search/list_documents. */
        .assistant-layout {
          grid-template-columns: minmax(0, 1fr) 280px;
        }
        .claudia-side.audio-side { display: none; }
      }
      @media (max-width: 800px) {
        .assistant-layout {
          grid-template-columns: 1fr;
        }
        .claudia-side {
          position: static; max-height: none; margin-top: 0;
        }
        .claudia-side.audio-side { display: block; }
      }

      /* ---- Audio panel rows (left sidebar) ---- */
      .claudia-audio-panel-empty { display: none; }
      .claudia-audio-list { display: flex; flex-direction: column; gap: 6px; }
      .claudia-audio-item {
        background: #fff; border: 1px solid #e2e8f0; border-radius: 6px;
        padding: 6px 8px;
      }
      .claudia-audio-head {
        display: flex; align-items: center; justify-content: space-between;
        gap: 0.4rem; margin-bottom: 4px;
      }
      .claudia-audio-filename {
        font-size: 11px; color: #64748b;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        flex: 1; min-width: 0;
      }
      .claudia-audio-transcript {
        font-size: 12px; color: #1f2937; line-height: 1.45;
        white-space: pre-wrap; word-wrap: break-word;
        display: -webkit-box; -webkit-box-orient: vertical;
        -webkit-line-clamp: 4; line-clamp: 4; overflow: hidden;
        cursor: pointer;
      }
      .claudia-audio-transcript.expanded {
        -webkit-line-clamp: unset; line-clamp: unset;
      }
      .claudia-audio-transcript.empty { color: #94a3b8; font-style: italic; cursor: default; }
      .claudia-audio-meta { font-size: 10px; color: #94a3b8; margin-top: 4px; }

      /* ---- Documents panel (rendered inside the sidebar) ---- */
      .claudia-docs-panel {
        margin: 0; padding: 0;
      }
      .claudia-docs-panel-empty { display: none; }
      .claudia-docs-list {
        display: flex; flex-direction: column; gap: 4px;
      }
      .claudia-doc {
        display: flex; align-items: flex-start; gap: 0.4rem;
        padding: 6px 8px; border-radius: 6px;
        background: #fff; border: 1px solid #e2e8f0;
      }
      .claudia-doc:hover { border-color: #cbd5e1; }
      .claudia-doc-main { flex: 1; min-width: 0; }
      .claudia-doc-title { display: flex; gap: 4px; align-items: center; font-size: 12px; font-weight: 500; color: #1a1a22; flex-wrap: wrap; }
      .claudia-doc-filename { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
      .claudia-doc-meta { font-size: 11px; color: #6b7280; margin-top: 1px; }
      .claudia-doc-badge {
        font-size: 10px; padding: 1px 6px; border-radius: 999px;
        font-weight: 500; letter-spacing: 0.02em;
      }
      .claudia-doc-badge.keep { background: #fef3c7; color: #92400e; }
      .claudia-doc-badge.warn { background: #fef9c3; color: #854d0e; }
      .claudia-doc-badge.error { background: #fee2e2; color: #991b1b; }
      .claudia-doc-actions { display: flex; gap: 4px; flex-shrink: 0; }
      .claudia-doc-btn {
        background: transparent; border: 1px solid transparent; color: #6b7280;
        cursor: pointer; padding: 2px 8px; border-radius: 4px; font-size: 14px;
        line-height: 1; min-width: 26px;
      }
      .claudia-doc-btn:hover { background: #f1f3f7; color: #1a1a22; border-color: #e2e8f0; }
      .claudia-doc-btn.active { color: #b45309; }
      .claudia-doc-btn.danger:hover { color: #b91c1c; background: #fef2f2; border-color: #fecaca; }
      .claudia-doc-flash {
        background: #fef2f2; border: 1px solid #fecaca; color: #991b1b;
        padding: 0.5rem 0.75rem; border-radius: 6px; font-size: 12px;
        margin-bottom: 6px;
      }
      .claudia-doc-flash ul { margin: 4px 0 0 1.25rem; padding: 0; }

      /* ---- Drop zone overlay (visible when dragging files over the wrap) ---- */
      .assistant-wrap.drag-active::after {
        content: 'Drop to upload (PDF · DOCX · XLSX · images · audio · email .eml/.mbox · zip · TXT/MD — up to 25 MB)';
        position: absolute; inset: 0;
        background: rgba(37, 102, 255, 0.08);
        border: 2px dashed #2566ff; border-radius: 12px;
        display: flex; align-items: center; justify-content: center;
        color: #1a4ab8; font-weight: 500; font-size: 14px;
        pointer-events: none; z-index: 5;
      }
      .assistant-wrap { position: relative; }

      /* ---- Attach button + busy spinner ---- */
      .assistant-form .attach-btn,
      .assistant-form .mic-btn {
        background: transparent; border: 1px solid #d0d0d5; color: #6b7280;
        padding: 10px 12px; border-radius: 8px; cursor: pointer;
        display: inline-flex; align-items: center; justify-content: center;
      }
      .assistant-form .attach-btn:hover,
      .assistant-form .mic-btn:hover { background: #f1f3f7; color: #1a1a22; }
      .assistant-form .attach-btn[aria-busy="true"] { opacity: 0.6; cursor: wait; }
      .assistant-form input[type="file"] { display: none; }
      /* Mic recording visual: pulsing red outline + dot. */
      .assistant-form .mic-btn.recording {
        background: #fee2e2; border-color: #ef4444; color: #b91c1c;
        animation: claudia-mic-pulse 1.4s infinite ease-in-out;
      }
      @keyframes claudia-mic-pulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.5); }
        50%      { box-shadow: 0 0 0 6px rgba(239, 68, 68, 0); }
      }
      .mic-recording-meta {
        display: none; font-size: 11px; color: #b91c1c; margin-top: 4px;
      }
      .assistant-form.recording .mic-recording-meta { display: inline-flex; gap: 4px; align-items: center; }
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
    <div class="assistant-layout">
    <aside class="claudia-side audio-side" id="claudia-side-audio">
      <h3>Voice notes</h3>
      ${raw(renderAudioPanel(audioDocs))}
      ${audioDocs.length === 0 ? html`<div class="claudia-side-empty">No recordings yet. Hit the mic next to the message box to capture a voice note — Claudia transcribes it via Whisper and you can ask her about it from the chat.</div>` : ''}
    </aside>
    <div class="assistant-wrap">
      <button type="button" id="chat-scroll-top" class="chat-scroll-jump" aria-label="Scroll to top of conversation" title="Top of conversation">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="6 15 12 9 18 15"/>
        </svg>
      </button>
      <button type="button" id="chat-scroll-bottom" class="chat-scroll-jump" aria-label="Scroll to latest message" title="Latest message">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
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
        hx-disabled-elt="find textarea, find #send-btn"
      >
        <button type="button" class="attach-btn" id="attach-btn" aria-label="Attach document" title="Attach (PDF · DOCX · XLSX · image · audio · email .eml/.mbox · zip · TXT / MD)">
          ${raw(ICON_PAPERCLIP)}
        </button>
        <button type="button" class="mic-btn" id="mic-btn" aria-label="Record audio" title="Record audio (transcribed via Whisper)">
          ${raw(ICON_MIC)}
        </button>
        <input type="file" id="attach-input" multiple accept=".pdf,.docx,.xlsx,.xls,.xlsm,.png,.jpg,.jpeg,.gif,.webp,.mp3,.wav,.m4a,.mp4,.ogg,.oga,.flac,.webm,.aac,.eml,.mbox,.zip,.txt,.md,.markdown,.csv,.tsv,.json,.xml,.yaml,.yml,.log,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,image/png,image/jpeg,image/gif,image/webp,audio/*,message/rfc822,application/mbox,application/zip,application/x-zip-compressed,text/plain,text/markdown,text/csv,text/tab-separated-values,application/json,application/xml">
        <textarea
          name="text"
          placeholder="Message..."
          rows="1"
          required
          autofocus
          onkeydown="if(event.key==='Enter' && !event.shiftKey){ event.preventDefault(); this.form.requestSubmit(); }"
        ></textarea>
        <button type="submit" id="send-btn">Send</button>
      </form>
    </div>
    <aside class="claudia-side docs-side" id="claudia-side-docs">
      <h3>Documents</h3>
      ${raw(renderDocsPanel(otherDocs))}
      ${otherDocs.length === 0 ? html`<div class="claudia-side-empty">No documents yet. Use the attach button or drag-drop anywhere on the chat to upload (PDF, DOCX, XLSX, image, TXT, MD).</div>` : ''}
    </aside>
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

        // ---- Document upload: attach button, file input, drag-drop ----
        const attachBtn = document.getElementById('attach-btn');
        const fileInput = document.getElementById('attach-input');
        const wrap = document.querySelector('.assistant-wrap');
        const PANEL_IDS = ['claudia-audio-panel', 'claudia-docs-panel'];

        function applyPanelHtml(html) {
          // The server returns BOTH panels with hx-swap-oob attributes.
          // For the JS upload path we don't have HTMX in the loop, so
          // parse the response and replace each panel by id.
          const tmp = document.createElement('template');
          tmp.innerHTML = html;
          for (const id of PANEL_IDS) {
            const incoming = tmp.content.querySelector('#' + id);
            if (!incoming) continue;
            const existing = document.getElementById(id);
            if (existing) existing.replaceWith(incoming);
          }
        }

        async function uploadFiles(files) {
          if (!files || files.length === 0) return;
          attachBtn?.setAttribute('aria-busy', 'true');
          const filenames = Array.from(files).map((f) => f && f.name).filter(Boolean);
          try {
            const fd = new FormData();
            for (const f of files) fd.append('file', f);
            const res = await fetch('/sandbox/assistant/documents', { method: 'POST', body: fd });
            const html = await res.text();
            applyPanelHtml(html);
            // Now that the doc(s) are in D1 with extraction complete, fire
            // an analyze turn so Claudia acknowledges + reads + suggests
            // actions without the user having to ask.
            if (filenames.length > 0) triggerUploadAnalysis(filenames);
          } catch (err) {
            console.error('upload failed:', err);
          } finally {
            attachBtn?.setAttribute('aria-busy', 'false');
            if (fileInput) fileInput.value = '';
          }
        }

        async function triggerUploadAnalysis(filenames) {
          const text = '[Just uploaded: ' + filenames.join(', ') + ']';
          if (list) {
            // Drop the empty-state intro on first activity.
            const empty = list.querySelector('.assistant-empty');
            if (empty) empty.remove();
            // Centered ghost note (matches server-side .system-trigger styling).
            const note = document.createElement('div');
            note.className = 'assistant-msg user system-trigger';
            note.textContent = text;
            list.appendChild(note);
            // Typing indicator while Claudia analyzes.
            const typing = document.createElement('div');
            typing.className = 'assistant-typing';
            typing.id = 'assistant-typing-indicator';
            typing.innerHTML = CLAUDIA_ICON_HTML;
            list.appendChild(typing);
            list.scrollTop = list.scrollHeight;
          }
          try {
            const fd = new FormData();
            fd.append('text', text);
            const res = await fetch('/sandbox/assistant/send', { method: 'POST', body: fd });
            const respHtml = await res.text();
            if (list) {
              list.innerHTML = respHtml;
              list.scrollTop = list.scrollHeight;
            }
          } catch (err) {
            console.error('upload analysis trigger failed:', err);
          }
        }

        // Click-to-expand on transcript snippets in the left sidebar.
        // Uses event delegation so it survives panel swaps.
        document.addEventListener('click', (e) => {
          const t = e.target;
          if (t && t.classList && t.classList.contains('claudia-audio-transcript') && !t.classList.contains('empty')) {
            t.classList.toggle('expanded');
          }
        });

        // Floating scroll-to-top / scroll-to-bottom buttons. Visible
        // only when (a) the messages pane is actually scrollable AND
        // (b) the user isn't already pinned to that edge.
        const scrollTopBtn = document.getElementById('chat-scroll-top');
        const scrollBottomBtn = document.getElementById('chat-scroll-bottom');
        const SCROLL_EDGE_PX = 32;
        function updateScrollButtons() {
          if (!list || !scrollTopBtn || !scrollBottomBtn) return;
          const scrollable = list.scrollHeight - list.clientHeight > SCROLL_EDGE_PX;
          if (!scrollable) {
            scrollTopBtn.classList.remove('visible');
            scrollBottomBtn.classList.remove('visible');
            return;
          }
          const atTop = list.scrollTop <= SCROLL_EDGE_PX;
          const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= SCROLL_EDGE_PX;
          scrollTopBtn.classList.toggle('visible', !atTop);
          scrollBottomBtn.classList.toggle('visible', !atBottom);
        }
        if (list) list.addEventListener('scroll', updateScrollButtons, { passive: true });
        if (scrollTopBtn) {
          scrollTopBtn.addEventListener('click', () => {
            list?.scrollTo({ top: 0, behavior: 'smooth' });
          });
        }
        if (scrollBottomBtn) {
          scrollBottomBtn.addEventListener('click', () => {
            list?.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
          });
        }
        // Recompute after any HTMX swap (new messages can change scrollability)
        // and on initial load. Use a small timeout so layout has settled.
        const recomputeSoon = () => setTimeout(updateScrollButtons, 50);
        if (form) {
          form.addEventListener('htmx:afterRequest', recomputeSoon);
          form.addEventListener('htmx:afterSwap', recomputeSoon);
        }
        recomputeSoon();

        if (attachBtn && fileInput) {
          attachBtn.addEventListener('click', () => fileInput.click());
          fileInput.addEventListener('change', (e) => uploadFiles(e.target.files));
        }

        // Drag-drop on the chat wrap. Counter handles nested dragenter/leave.
        if (wrap) {
          let dragDepth = 0;
          const looksLikeFiles = (e) => {
            const types = e.dataTransfer && e.dataTransfer.types;
            if (!types) return false;
            for (const t of types) if (t === 'Files') return true;
            return false;
          };
          wrap.addEventListener('dragenter', (e) => {
            if (!looksLikeFiles(e)) return;
            e.preventDefault();
            dragDepth++;
            wrap.classList.add('drag-active');
          });
          wrap.addEventListener('dragover', (e) => {
            if (!looksLikeFiles(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          });
          wrap.addEventListener('dragleave', (e) => {
            if (!looksLikeFiles(e)) return;
            dragDepth = Math.max(0, dragDepth - 1);
            if (dragDepth === 0) wrap.classList.remove('drag-active');
          });
          wrap.addEventListener('drop', (e) => {
            if (!looksLikeFiles(e)) return;
            e.preventDefault();
            dragDepth = 0;
            wrap.classList.remove('drag-active');
            uploadFiles(e.dataTransfer.files);
          });
        }

        // ---- Microphone capture (browser → Whisper-transcribed audio file) ----
        const micBtn = document.getElementById('mic-btn');
        let mediaRecorder = null;
        let recStream = null;
        let recChunks = [];

        function pickAudioMime() {
          const candidates = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/mp4',
            'audio/ogg;codecs=opus',
            'audio/ogg',
          ];
          for (const m of candidates) {
            if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) {
              return m;
            }
          }
          return ''; // browser default
        }

        async function startRecording() {
          if (!navigator.mediaDevices || !window.MediaRecorder) {
            alert('Your browser does not support microphone capture.');
            return;
          }
          try {
            recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          } catch (err) {
            alert('Microphone access denied: ' + (err && err.message ? err.message : err));
            return;
          }
          recChunks = [];
          const mime = pickAudioMime();
          mediaRecorder = mime ? new MediaRecorder(recStream, { mimeType: mime }) : new MediaRecorder(recStream);
          mediaRecorder.addEventListener('dataavailable', (e) => {
            if (e.data && e.data.size > 0) recChunks.push(e.data);
          });
          mediaRecorder.addEventListener('stop', async () => {
            try {
              recStream.getTracks().forEach((t) => t.stop());
            } catch {}
            recStream = null;
            const blobType = mediaRecorder.mimeType || 'audio/webm';
            const ext = blobType.includes('mp4') ? 'm4a' : blobType.includes('ogg') ? 'ogg' : 'webm';
            const blob = new Blob(recChunks, { type: blobType });
            const file = new File([blob], 'voice-note-' + Date.now() + '.' + ext, { type: blobType });
            await uploadFiles([file]);
            mediaRecorder = null;
            recChunks = [];
          });
          mediaRecorder.start();
          micBtn.classList.add('recording');
          form.classList.add('recording');
          micBtn.setAttribute('aria-pressed', 'true');
          micBtn.title = 'Stop recording and upload';
        }

        function stopRecording() {
          if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            try { mediaRecorder.stop(); } catch {}
          }
          micBtn.classList.remove('recording');
          form.classList.remove('recording');
          micBtn.setAttribute('aria-pressed', 'false');
          micBtn.title = 'Record audio (transcribed via Whisper)';
        }

        if (micBtn) {
          micBtn.addEventListener('click', () => {
            if (mediaRecorder && mediaRecorder.state === 'recording') {
              stopRecording();
            } else {
              startRecording();
            }
          });
        }
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
