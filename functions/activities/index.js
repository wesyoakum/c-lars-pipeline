// functions/activities/index.js
//
// GET  /activities  — Task/activity list (defaults to "my open tasks")
// POST /activities  — Create a new activity/task

import { all, one, stmt, batch } from '../lib/db.js';
import { auditStmt } from '../lib/audit.js';
import { layout, htmlResponse, html, raw, escape } from '../lib/layout.js';
import { uuid, now } from '../lib/ids.js';
import { redirectWithFlash, formBody, readFlash } from '../lib/http.js';
import { listScript, listTableHead, listToolbar, rowDataAttrs } from '../lib/list-table.js';
import { ieText, listInlineEditScript } from '../lib/list-inline-edit.js';
import { isActiveOnly } from '../lib/activeness.js';

const TYPE_LABELS = {
  task: 'Task',
  note: 'Note',
  email: 'Email',
  call: 'Call',
  meeting: 'Meeting',
};

const STATUS_LABELS = {
  pending: 'Pending',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const flash = readFlash(url);

  const filter = url.searchParams.get('filter') || 'mine';
  // Global active_only pref forces completed tasks out of view, even
  // if the URL asked for them. Without the pref, the per-list
  // ?completed=1 toggle still works.
  const showCompleted = !isActiveOnly(user) && url.searchParams.get('completed') === '1';
  const typeFilter = url.searchParams.get('type') || '';

  // Build WHERE clause
  const conditions = [];
  const params = [];

  if (filter === 'mine' && user?.id) {
    conditions.push('a.assigned_user_id = ?');
    params.push(user.id);
  }

  if (!showCompleted) {
    conditions.push("a.status = 'pending'");
  }

  if (typeFilter) {
    conditions.push('a.type = ?');
    params.push(typeFilter);
  }

  const where = conditions.length > 0
    ? 'WHERE ' + conditions.join(' AND ')
    : '';

  const activities = await all(env.DB,
    `SELECT a.*,
            o.number AS opp_number, o.title AS opp_title,
            u.display_name AS assigned_name, u.email AS assigned_email,
            cu.display_name AS created_by_name, cu.email AS created_by_email
       FROM activities a
       LEFT JOIN opportunities o ON o.id = a.opportunity_id
       LEFT JOIN users u ON u.id = a.assigned_user_id
       LEFT JOIN users cu ON cu.id = a.created_by_user_id
     ${where}
     ORDER BY
       CASE WHEN a.status = 'pending' THEN 0 ELSE 1 END,
       CASE WHEN a.due_at IS NOT NULL THEN 0 ELSE 1 END,
       a.due_at ASC,
       a.created_at DESC
     LIMIT 200`,
    params);

  const overdueTasks = activities.filter(a =>
    a.status === 'pending' && a.due_at && a.due_at < new Date().toISOString().slice(0, 10)
  ).length;

  const columns = [
    { key: 'done',          label: '\u2713',       sort: 'text',   filter: null,     default: true },
    { key: 'open',          label: '\u2197',      sort: 'text',   filter: null,     default: true },
    { key: 'subject',       label: 'Subject',     sort: 'text',   filter: 'text',   default: true },
    { key: 'type_label',    label: 'Type',         sort: 'text',   filter: 'select', default: true },
    { key: 'opp_number',    label: 'Opportunity',  sort: 'text',   filter: 'text',   default: true },
    { key: 'assigned_name', label: 'Assigned to',  sort: 'text',   filter: 'select', default: true },
    { key: 'due',           label: 'Due',          sort: 'date',   filter: 'text',   default: true },
    { key: 'status_label',  label: 'Status',       sort: 'text',   filter: 'select', default: true },
  ];

  const rowData = activities.map(a => {
    const isOverdue = a.status === 'pending' && a.due_at && a.due_at < new Date().toISOString().slice(0, 10);
    return {
      id: a.id,
      // `done` is a sort/filter-friendly proxy for status. Sorting on it
      // groups pending tasks above completed ones.
      done: a.status === 'completed' ? '1' : '0',
      subject: a.subject ?? '',
      body_preview: a.body ? (a.body.length > 80 ? a.body.slice(0, 80) + '...' : a.body) : '',
      type: a.type,
      type_label: TYPE_LABELS[a.type] ?? a.type,
      opportunity_id: a.opportunity_id,
      opp_number: a.opp_number ?? '',
      opp_title: a.opp_title ?? '',
      assigned_name: a.assigned_name ?? a.assigned_email ?? '\u2014',
      due: a.due_at ? a.due_at.slice(0, 10) : '',
      status: a.status,
      status_label: STATUS_LABELS[a.status] ?? a.status ?? '\u2014',
      isOverdue,
      isCompleted: a.status === 'completed',
    };
  });

  const body = html`
    <section class="card">
      <div class="card-header">
        <h1 class="page-title">Tasks & Activities</h1>
      </div>
    </section>

    <nav class="card" style="padding: 0.5rem 1rem; display:flex; align-items:center; gap:1rem; flex-wrap:wrap;">
      <a class="nav-link ${filter === 'mine' ? 'active' : ''}" href="/activities?filter=mine${showCompleted ? '&completed=1' : ''}">My tasks</a>
      <a class="nav-link ${filter === 'all' ? 'active' : ''}" href="/activities?filter=all${showCompleted ? '&completed=1' : ''}">All tasks</a>
      <span style="flex:1"></span>
      <label style="font-size:0.85em; display:flex; align-items:center; gap:0.3rem;">
        <input type="checkbox" onchange="window.location.href='/activities?filter=${escape(filter)}'+(this.checked?'&completed=1':'')" ${showCompleted ? 'checked' : ''}>
        Show completed
      </label>
    </nav>

    ${overdueTasks > 0 ? html`
      <div class="flash flash-warn">${overdueTasks} overdue task${overdueTasks > 1 ? 's' : ''}</div>
    ` : ''}

    <section class="card">
      <div class="card-header">
        <h2>Activities</h2>
        <div class="toolbar-right" style="display:flex;align-items:center;gap:0.5rem">
          ${listToolbar({
            id: 'act',
            count: activities.length,
            columns,
            newOnClick: 'window.Pipeline && window.Pipeline.openTaskModal({})',
            newLabel: 'New task',
          })}
        </div>
      </div>

      ${activities.length === 0
        ? html`<p class="muted">No activities found.</p>`
        : html`
          <div class="opp-list" data-columns="${escape(JSON.stringify(columns))}">
            <table class="data compact opp-list-table">
              ${listTableHead(columns, rowData)}
              <tbody data-role="rows">
                ${rowData.map(r => html`
                  <tr data-row-id="${escape(r.id)}"
                      ${raw(rowDataAttrs(columns, r))}
                      class="${r.isCompleted ? 'row-muted' : ''} ${r.isOverdue ? 'row-overdue' : ''}">
                    <td class="col-done" data-col="done">
                      <button type="button"
                              class="task-complete-toggle ${r.isCompleted ? 'is-completed' : ''}"
                              title="${r.isCompleted ? 'Mark pending' : 'Mark complete'}"
                              aria-label="${r.isCompleted ? 'Mark pending' : 'Mark complete'}"></button>
                    </td>
                    <td class="col-open" data-col="open">
                      <a class="row-open-link" href="/activities/${escape(r.id)}" title="Open activity" aria-label="Open activity">\u2197</a>
                    </td>
                    <td class="col-subject" data-col="subject">
                      ${ieText('subject', r.subject, { placeholder: '(no subject)' })}
                      ${r.body_preview ? html`<br><small class="muted">${escape(r.body_preview)}</small>` : ''}
                    </td>
                    <td class="col-type_label" data-col="type_label"><span class="pill pill-${r.type}">${escape(r.type_label)}</span></td>
                    <td class="col-opp_number" data-col="opp_number">
                      ${r.opportunity_id
                        ? html`<a href="/opportunities/${escape(r.opportunity_id)}"><code>${escape(r.opp_number)}</code></a>`
                        : html`<span class="muted">\u2014</span>`}
                    </td>
                    <td class="col-assigned_name" data-col="assigned_name">${escape(r.assigned_name)}</td>
                    <td class="col-due ${r.isOverdue ? 'overdue-text' : ''}" data-col="due">
                      ${ieText('due_at', r.due, { inputType: 'date' })}
                    </td>
                    <td class="col-status_label" data-col="status_label"><span class="pill ${r.status === 'completed' ? 'pill-success' : r.status === 'cancelled' ? 'pill-locked' : ''}">${escape(r.status_label)}</span></td>
                  </tr>
                `)}
              </tbody>
            </table>
          </div>
          <script>${raw(listScript('pipeline.activities.v1', 'due', 'asc'))}</script>
          <script>${raw(listInlineEditScript('/activities/:id/patch', {
            // Column key `due` maps to patch field `due_at`.
            fieldAttrMap: { due_at: 'due' },
          }))}</script>
          <script>${raw(taskCompleteToggleScript())}</script>
        `}
    </section>
  `;

  return htmlResponse(layout('Tasks & Activities', body, {
    user,
    env: data?.env,
    activeNav: '/activities',
    flash,
    breadcrumbs: [{ label: 'Tasks & Activities' }],
  }));
}

/**
 * Client script: click the circle in the "Done" column to flip a task's
 * status pending ↔ completed. Optimistic UI: paints immediately, then
 * reverts if the patch comes back with !ok. Stops propagation so the
 * inline-edit handler on the same tbody doesn't try to open an editor.
 */
function taskCompleteToggleScript() {
  return `
(function() {
  var host = document.querySelector('.opp-list');
  if (!host) return;
  var tbody = host.querySelector('[data-role="rows"]');
  if (!tbody) return;

  tbody.addEventListener('click', function(e) {
    var btn = e.target.closest('.task-complete-toggle');
    if (!btn || !tbody.contains(btn)) return;
    e.preventDefault();
    e.stopPropagation();

    var tr = btn.closest('tr[data-row-id]');
    if (!tr) return;
    var id = tr.dataset.rowId;
    var wasCompleted = btn.classList.contains('is-completed');
    var newStatus = wasCompleted ? 'pending' : 'completed';

    // Optimistic flip.
    paint(tr, btn, newStatus);

    fetch('/activities/' + encodeURIComponent(id) + '/patch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field: 'status', value: newStatus }),
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data || !data.ok) {
          paint(tr, btn, wasCompleted ? 'completed' : 'pending');
          if (data && data.error) {
            btn.title = data.error;
            setTimeout(function() {
              btn.title = wasCompleted ? 'Mark complete' : 'Mark pending';
            }, 2500);
          }
        }
      })
      .catch(function() {
        paint(tr, btn, wasCompleted ? 'completed' : 'pending');
      });
  });

  function paint(tr, btn, status) {
    var done = status === 'completed';
    btn.classList.toggle('is-completed', done);
    btn.title = done ? 'Mark pending' : 'Mark complete';
    btn.setAttribute('aria-label', btn.title);
    tr.classList.toggle('row-muted', done);
    // Keep the row's data-* attributes in sync so list-table.js's
    // sort/filter/quicksearch see the new status without a reload.
    tr.setAttribute('data-done', done ? '1' : '0');
    tr.setAttribute('data-status_label', done ? 'Completed' : 'Pending');
    // Update the status pill in the same row.
    var pill = tr.querySelector('.col-status_label .pill');
    if (pill) {
      pill.textContent = done ? 'Completed' : 'Pending';
      pill.classList.toggle('pill-success', done);
    }
  }
})();
`;
}

// POST /activities — Create a new activity.
//
// Normalized for the new "New task" modal:
//   - type is always forced to 'task' (modal only creates tasks).
//     The DB column + schema still support note/email/call/meeting
//     and we keep them here so legacy code paths (e.g. notes form)
//     don't break, but the modal UX only emits tasks.
//   - subject is auto-derived from the first 20 chars of body + "..."
//     if the caller didn't supply one. Tasks don't need a standalone
//     subject field — users type a single details box and move on.
//   - remind_at is stored if supplied.
//   - Accepts opportunity_id, quote_id, or account_id as the linked
//     entity (at most one).
//
// Two response modes:
//   - If the request came from the modal (source=modal or an Ajax
//     x-requested-with header), return JSON { ok: true, id } so the
//     client can close the modal and reload.
//   - Otherwise fall back to the classic redirect-with-flash pattern
//     used by legacy inline forms.
function deriveSubject(explicit, body) {
  const trimmedExplicit = (explicit || '').trim();
  if (trimmedExplicit) return trimmedExplicit;
  const trimmedBody = (body || '').trim();
  if (!trimmedBody) return '';
  // Take the first line, first 20 chars, append … if truncated.
  const firstLine = trimmedBody.split(/\r?\n/)[0];
  if (firstLine.length <= 20) return firstLine;
  return firstLine.slice(0, 20) + '…';
}

function isAjaxRequest(request, input) {
  if (input?.source === 'modal') return true;
  const xrw = request.headers.get('x-requested-with');
  if (xrw && xrw.toLowerCase() === 'xmlhttprequest') return true;
  const accept = request.headers.get('accept') || '';
  return accept.includes('application/json') && !accept.includes('text/html');
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const input = await formBody(request);
  const ajax = isAjaxRequest(request, input);

  const id = uuid();
  const ts = now();

  // Type is intentionally locked to 'task' for modal-created rows.
  // Callers can still pass an explicit non-task type (notes, calls, etc.)
  // for legacy flows; only the modal leaves type blank.
  const type = input.type || 'task';
  const body = (input.body || '').trim() || null;
  const subject = deriveSubject(input.subject, input.body);
  const oppId = input.opportunity_id || null;
  const quoteId = input.quote_id || null;
  const accountId = input.account_id || null;
  const assignedUserId = input.assigned_user_id || user?.id || null;
  const dueAt = input.due_at || null;
  const remindAt = input.remind_at || null;
  const direction = input.direction || null;
  const status = (type === 'task') ? 'pending' : 'completed';

  if (!subject) {
    const msg = 'Please enter task details.';
    if (ajax) return jsonResponse({ ok: false, error: msg }, 400);
    return redirectWithFlash('/activities', msg, 'error');
  }

  const returnTo = input.return_to || null;

  await batch(env.DB, [
    stmt(env.DB,
      `INSERT INTO activities (
         id, opportunity_id, account_id, quote_id, type, subject, body,
         direction, status, due_at, remind_at, assigned_user_id,
         created_at, updated_at, created_by_user_id
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, oppId, accountId, quoteId, type, subject, body,
       direction, status, dueAt, remindAt, assignedUserId,
       ts, ts, user?.id]),
    auditStmt(env.DB, {
      entityType: 'activity',
      entityId: id,
      eventType: 'created',
      user,
      summary: `Created ${type}: ${subject}`,
    }),
  ]);

  if (ajax) {
    return jsonResponse({ ok: true, id, subject });
  }

  const flashMsg = `Created ${TYPE_LABELS[type] ?? type}: ${subject}`;
  if (returnTo) return redirectWithFlash(returnTo, flashMsg);
  return redirectWithFlash('/activities', flashMsg);
}
