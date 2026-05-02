// functions/lib/claudia-threads-render.js
//
// Render helpers for Claudia's threads sidebar. Kept in functions/lib/
// (not under functions/sandbox/assistant/) because the Cloudflare Pages
// Functions bundler can't resolve sibling-module imports out of route
// directories that contain bracketed segments like [id]/. Lib/ is the
// canonical location for shared modules.
//
// Used by:
//   - functions/sandbox/assistant/index.js (initial render)
//   - functions/sandbox/assistant/threads/[id]/rename.js (single-row
//     outerHTML swap after a rename POST)
// Both produce byte-identical markup.

import { html, escape } from './layout.js';

/**
 * Render one thread row. The div's id is `thread-row-<threadId>` so
 * HTMX endpoints can swap it via outerHTML.
 *
 * Inline rename + delete affordances live behind a hover/focus state
 * so the strip reads quietly until you hover. The rename input starts
 * hidden and is revealed when the rename button is clicked via the
 * `claudiaThreadRename(id)` helper defined inline in index.js.
 */
export function renderThreadRow(t, activeThreadId) {
  const isActive = t.id === activeThreadId;
  const title = t.title || 'New chat';
  const updatedShort = formatRelativeShort(t.updated_at);
  const msgCount = Number(t.message_count || 0);
  return html`
    <div class="threads-row${isActive ? ' threads-row--active' : ''}" id="thread-row-${escape(t.id)}" data-thread-id="${escape(t.id)}">
      <a class="threads-row-link" href="/sandbox/assistant?thread=${escape(t.id)}">
        <span class="threads-row-title" title="${escape(title)}">${escape(title)}</span>
        <span class="threads-row-meta">${escape(updatedShort)}${msgCount > 0 ? ` · ${msgCount}` : ''}</span>
      </a>
      <div class="threads-row-actions">
        <button type="button" class="threads-row-btn threads-row-rename"
                aria-label="Rename"
                title="Rename"
                onclick="claudiaThreadRename('${escape(t.id)}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="13" height="13">
            <path d="M12 20h9"/>
            <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z"/>
          </svg>
        </button>
        <button type="button" class="threads-row-btn threads-row-delete"
                aria-label="Delete thread"
                title="Delete thread"
                hx-post="/sandbox/assistant/threads/${escape(t.id)}/delete${isActive ? '?was_active=1' : ''}"
                hx-target="#thread-row-${escape(t.id)}"
                hx-swap="outerHTML"
                hx-confirm="Delete this thread and all its messages? This can't be undone.">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="13" height="13">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            <path d="M10 11v6"/>
            <path d="M14 11v6"/>
          </svg>
        </button>
      </div>
      <form class="threads-row-rename-form"
            style="display:none"
            hx-post="/sandbox/assistant/threads/${escape(t.id)}/rename?active=${escape(activeThreadId || '')}"
            hx-target="#thread-row-${escape(t.id)}"
            hx-swap="outerHTML"
            onsubmit="event.stopPropagation()">
        <input type="text" name="title" value="${escape(title)}" maxlength="80" required
               onblur="this.form.requestSubmit()"
               onkeydown="if(event.key==='Escape'){ event.preventDefault(); this.closest('.threads-row').querySelector('.threads-row-link').style.display=''; this.closest('form').style.display='none'; }">
      </form>
    </div>
  `;
}

/**
 * Compact relative-time stamp for the strip — "now", "12m", "3h",
 * "2d", "Mar 14". Lighter than a full "X minutes ago" line; the strip
 * needs to fit a lot of chips horizontally.
 */
export function formatRelativeShort(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return String(iso).slice(0, 10);
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  const d = new Date(ms);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric' });
}
