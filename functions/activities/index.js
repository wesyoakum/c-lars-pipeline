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
  const showCompleted = url.searchParams.get('completed') === '1';
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

  // Load opportunities and users for the create form
  const opportunities = await all(env.DB,
    `SELECT id, number, title FROM opportunities
      WHERE stage NOT IN ('closed_won', 'closed_lost', 'closed_abandoned')
      ORDER BY updated_at DESC LIMIT 100`);

  const users = await all(env.DB,
    `SELECT id, display_name, email FROM users WHERE active = 1 ORDER BY display_name, email`);

  const overdueTasks = activities.filter(a =>
    a.status === 'pending' && a.due_at && a.due_at < new Date().toISOString().slice(0, 10)
  ).length;

  const columns = [
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
          ${listToolbar({ id: 'act', count: activities.length, columns })}
          <button class="btn btn-sm primary" onclick="document.getElementById('new-activity-form').style.display = document.getElementById('new-activity-form').style.display === 'none' ? 'block' : 'none'">+ New</button>
        </div>
      </div>

      <div id="new-activity-form" style="display:none; margin-bottom:1rem; padding:1rem; background:var(--bg-muted,#f6f8fa); border-radius:var(--radius);">
        <form method="post" action="/activities">
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.5rem;">
            <div>
              <label class="field-label">Type</label>
              <select name="type" required style="width:100%">
                ${Object.entries(TYPE_LABELS).map(([k, v]) => html`
                  <option value="${k}" ${k === 'task' ? 'selected' : ''}>${v}</option>
                `)}
              </select>
            </div>
            <div>
              <label class="field-label">Opportunity</label>
              <select name="opportunity_id" style="width:100%">
                <option value="">— none —</option>
                ${opportunities.map(o => html`
                  <option value="${o.id}">${escape(o.number)} — ${escape(o.title)}</option>
                `)}
              </select>
            </div>
            <div style="grid-column:1/-1">
              <label class="field-label">Subject</label>
              <input type="text" name="subject" required style="width:100%">
            </div>
            <div style="grid-column:1/-1">
              <label class="field-label">Details</label>
              <textarea name="body" rows="2" style="width:100%; field-sizing:content; min-height:2.5rem;"></textarea>
            </div>
            <div>
              <label class="field-label">Assigned to</label>
              <select name="assigned_user_id" style="width:100%">
                ${users.map(u => html`
                  <option value="${u.id}" ${u.id === user?.id ? 'selected' : ''}>${escape(u.display_name ?? u.email)}</option>
                `)}
              </select>
            </div>
            <div>
              <label class="field-label">Due date</label>
              <input type="date" name="due_at" style="width:100%">
            </div>
            <div>
              <label class="field-label">Direction</label>
              <select name="direction" style="width:100%">
                <option value="">—</option>
                <option value="inbound">Inbound</option>
                <option value="outbound">Outbound</option>
              </select>
            </div>
          </div>
          <div style="margin-top:0.75rem; display:flex; gap:0.5rem;">
            <button class="btn primary" type="submit">Create</button>
            <button class="btn" type="button" onclick="document.getElementById('new-activity-form').style.display='none'">Cancel</button>
          </div>
        </form>
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
                    <td class="col-subject" data-col="subject">
                      <a href="/activities/${escape(r.id)}" class="${r.isCompleted ? 'completed-text' : ''}">
                        <strong>${escape(r.subject || '(no subject)')}</strong>
                      </a>
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
                      ${r.due ? escape(r.due) : html`<span class="muted">\u2014</span>`}
                    </td>
                    <td class="col-status_label" data-col="status_label"><span class="pill ${r.status === 'completed' ? 'pill-success' : r.status === 'cancelled' ? 'pill-locked' : ''}">${escape(r.status_label)}</span></td>
                  </tr>
                `)}
              </tbody>
            </table>
          </div>
          <script>${raw(listScript('pms.activities.v1', 'due', 'asc'))}</script>
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

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const input = await formBody(request);

  const id = uuid();
  const ts = now();
  const type = input.type || 'task';
  const subject = (input.subject || '').trim();
  const body = (input.body || '').trim() || null;
  const oppId = input.opportunity_id || null;
  const assignedUserId = input.assigned_user_id || user?.id || null;
  const dueAt = input.due_at || null;
  const direction = input.direction || null;
  const status = (type === 'task') ? 'pending' : 'completed';

  if (!subject) {
    return redirectWithFlash('/activities', 'Subject is required.', 'error');
  }

  // If created from an opportunity page, redirect back there
  const returnTo = input.return_to || null;

  await batch(env.DB, [
    stmt(env.DB,
      `INSERT INTO activities (id, opportunity_id, type, subject, body, direction, status, due_at, assigned_user_id, created_at, updated_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, oppId, type, subject, body, direction, status, dueAt, assignedUserId, ts, ts, user?.id]),
    auditStmt(env.DB, {
      entityType: 'activity',
      entityId: id,
      eventType: 'created',
      user,
      summary: `Created ${type}: ${subject}`,
    }),
  ]);

  if (returnTo) {
    return redirectWithFlash(returnTo, `Created ${TYPE_LABELS[type] ?? type}: ${subject}`);
  }
  return redirectWithFlash('/activities', `Created ${TYPE_LABELS[type] ?? type}: ${subject}`);
}
