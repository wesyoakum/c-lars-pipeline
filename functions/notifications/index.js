// functions/notifications/index.js
//
// GET /notifications — the full history page for the current user.
//
// Renders every notification for the user (up to 100), newest first,
// with unread rows visually distinguished. Clicking an unread row
// marks it as read (client-side fetch) then follows the link_url if
// one is present. A "Mark all read" button clears the unread state
// in one batch.
//
// This is the "see what you missed" counterpart to the Phase 1 toast
// stack. The toasts only fire for notifications that arrive while a
// page is open; this page is where users go to see the full history.

import { getRecentForUser, getUnreadCount } from '../lib/notify.js';
import { layout, htmlResponse, escape } from '../lib/layout.js';
import { readFlash } from '../lib/http.js';

// Human-friendly label for the `type` column. Falls back to the raw
// value if a new type shows up that we haven't mapped yet.
const TYPE_LABELS = {
  stage_changed:    'Stage changed',
  quote_issued:     'Quote issued',
  quote_expired:    'Quote expired',
  task_overdue:     'Task overdue',
  task_reminder:    'Task reminder',
  opportunity_won:  'Opportunity won',
  opportunity_lost: 'Opportunity lost',
  note_mention:     'Mention',
  system:           'System',
};

function labelForType(type) {
  return TYPE_LABELS[type] || type || 'Notification';
}

function formatRelative(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const nowMs = Date.now();
  const deltaSec = Math.round((nowMs - then) / 1000);
  if (deltaSec < 60)     return 'just now';
  if (deltaSec < 3600)   return Math.floor(deltaSec / 60) + 'm ago';
  if (deltaSec < 86400)  return Math.floor(deltaSec / 3600) + 'h ago';
  if (deltaSec < 604800) return Math.floor(deltaSec / 86400) + 'd ago';
  // Fall back to an absolute date for anything older than a week.
  return new Date(iso).toLocaleDateString();
}

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const flash = readFlash(url);

  if (!user || !user.id) {
    return htmlResponse(
      layout('Notifications', '<section class="card"><p>Not signed in.</p></section>', { user, flash }),
    );
  }

  const [rows, unreadCount] = await Promise.all([
    getRecentForUser(env.DB, user.id, 100),
    getUnreadCount(env.DB, user.id),
  ]);

  const rowsHtml = rows.length === 0
    ? '<p class="muted">No notifications yet. As you work in PMS, you\'ll see updates here.</p>'
    : `<ul class="notification-list" x-data="{ markOne: function(id) { fetch('/notifications/' + encodeURIComponent(id) + '/read', { method: 'POST', credentials: 'same-origin' }).catch(function(){}); } }">
         ${rows.map((n) => {
           const unread = n.read_at == null;
           const link = n.link_url || '#';
           const clickHandler = unread
             ? `@click="markOne('${escape(n.id)}')"`
             : '';
           return `<li class="notification-row ${unread ? 'notification-row--unread' : ''}">
             <a href="${escape(link)}" class="notification-row-link" ${clickHandler}>
               <div class="notification-row-main">
                 <div class="notification-row-title">${escape(n.title)}</div>
                 ${n.body ? `<div class="notification-row-body">${escape(n.body)}</div>` : ''}
               </div>
               <div class="notification-row-meta">
                 <span class="notification-row-type">${escape(labelForType(n.type))}</span>
                 <span class="notification-row-time" title="${escape(n.created_at)}">${escape(formatRelative(n.created_at))}</span>
               </div>
             </a>
           </li>`;
         }).join('')}
       </ul>`;

  const markAllButton = unreadCount > 0
    ? `<form method="post" action="/notifications/mark-all-read" style="display:inline;">
         <button type="submit" class="btn btn-secondary">Mark all read (${unreadCount})</button>
       </form>`
    : '';

  const body = `
    <section class="card">
      <div class="card-header">
        <h1>Notifications</h1>
        <div class="card-header-actions">${markAllButton}</div>
      </div>
      ${rowsHtml}
    </section>
  `;

  return htmlResponse(
    layout('Notifications', body, {
      user,
      flash,
      breadcrumbs: [
        { label: 'PMS', href: '/' },
        { label: 'Notifications' },
      ],
    }),
  );
}
