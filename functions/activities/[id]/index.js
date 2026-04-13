// functions/activities/[id]/index.js
//
// GET  /activities/:id  — Activity detail / edit form
// POST /activities/:id  — Update activity

import { one, all, stmt, batch } from '../../lib/db.js';
import { auditStmt, diff } from '../../lib/audit.js';
import { layout, htmlResponse, html, escape } from '../../lib/layout.js';
import { now } from '../../lib/ids.js';
import { redirectWithFlash, formBody, readFlash } from '../../lib/http.js';

const TYPE_LABELS = {
  task: 'Task',
  note: 'Note',
  email: 'Email',
  call: 'Call',
  meeting: 'Meeting',
};

const UPDATE_FIELDS = [
  'type', 'subject', 'body', 'direction', 'status',
  'due_at', 'assigned_user_id', 'opportunity_id',
];

export async function onRequestGet(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const flash = readFlash(url);
  const actId = params.id;

  const act = await one(env.DB,
    `SELECT a.*,
            o.number AS opp_number, o.title AS opp_title,
            u.display_name AS assigned_name, u.email AS assigned_email,
            cu.display_name AS created_by_name, cu.email AS created_by_email
       FROM activities a
       LEFT JOIN opportunities o ON o.id = a.opportunity_id
       LEFT JOIN users u ON u.id = a.assigned_user_id
       LEFT JOIN users cu ON cu.id = a.created_by_user_id
      WHERE a.id = ?`,
    [actId]);

  if (!act) {
    return htmlResponse(layout('Not found', '<section class="card"><h1>Activity not found</h1><p><a href="/activities">Back</a></p></section>', {
      user, env: data?.env, activeNav: '/activities',
    }), { status: 404 });
  }

  const opportunities = await all(env.DB,
    `SELECT id, number, title FROM opportunities ORDER BY updated_at DESC LIMIT 100`);
  const users = await all(env.DB,
    `SELECT id, display_name, email FROM users WHERE active = 1 ORDER BY display_name, email`);

  // Audit events for this activity
  const events = await all(env.DB,
    `SELECT ae.event_type, ae.at, ae.summary,
            u.display_name AS user_name, u.email AS user_email
       FROM audit_events ae
       LEFT JOIN users u ON u.id = ae.user_id
      WHERE ae.entity_type = 'activity' AND ae.entity_id = ?
      ORDER BY ae.at DESC LIMIT 50`,
    [actId]);

  const isTask = act.type === 'task';
  const createdByLabel = act.created_by_name ?? act.created_by_email ?? '—';

  const body = html`
    <section class="card">
      <div class="card-header">
        <h1 class="page-title">${escape(act.subject || '(no subject)')}</h1>
        <div class="header-actions" style="display:flex; gap:0.5rem;">
          ${act.status === 'pending' ? html`
            <form method="post" action="/activities/${escape(actId)}/complete" style="display:inline">
              <button class="btn btn-sm primary" type="submit">Mark complete</button>
            </form>
          ` : ''}
          <form method="post" action="/activities/${escape(actId)}/delete"
                onsubmit="return confirm('Delete this activity?')">
            <button class="btn btn-sm" type="submit">Delete</button>
          </form>
        </div>
      </div>
      <p class="muted" style="margin:0.15rem 0 0">
        <span class="pill pill-${act.type}">${escape(TYPE_LABELS[act.type] ?? act.type)}</span>
        · Created by ${escape(createdByLabel)}
        · ${escape((act.created_at ?? '').slice(0, 16).replace('T', ' '))}
        ${act.status === 'completed' ? html` · <span class="pill pill-success">Completed</span> ${act.completed_at ? escape(act.completed_at.slice(0, 16).replace('T', ' ')) : ''}` : ''}
        ${act.status === 'cancelled' ? html` · <span class="pill pill-locked">Cancelled</span>` : ''}
      </p>
    </section>

    <section class="card">
      <h2>Edit</h2>
      <form method="post" action="/activities/${escape(actId)}">
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.5rem;">
          <div>
            <label class="field-label">Type</label>
            <select name="type" style="width:100%">
              ${Object.entries(TYPE_LABELS).map(([k, v]) => html`
                <option value="${k}" ${act.type === k ? 'selected' : ''}>${v}</option>
              `)}
            </select>
          </div>
          <div>
            <label class="field-label">Status</label>
            <select name="status" style="width:100%">
              <option value="pending" ${act.status === 'pending' ? 'selected' : ''}>Pending</option>
              <option value="completed" ${act.status === 'completed' ? 'selected' : ''}>Completed</option>
              <option value="cancelled" ${act.status === 'cancelled' ? 'selected' : ''}>Cancelled</option>
            </select>
          </div>
          <div style="grid-column:1/-1">
            <label class="field-label">Subject</label>
            <input type="text" name="subject" value="${escape(act.subject ?? '')}" required style="width:100%">
          </div>
          <div style="grid-column:1/-1">
            <label class="field-label">Details</label>
            <textarea name="body" rows="3" style="width:100%; field-sizing:content; min-height:3rem;">${escape(act.body ?? '')}</textarea>
          </div>
          <div>
            <label class="field-label">Opportunity</label>
            <select name="opportunity_id" style="width:100%">
              <option value="">— none —</option>
              ${opportunities.map(o => html`
                <option value="${o.id}" ${act.opportunity_id === o.id ? 'selected' : ''}>${escape(o.number)} — ${escape(o.title)}</option>
              `)}
            </select>
          </div>
          <div>
            <label class="field-label">Assigned to</label>
            <select name="assigned_user_id" style="width:100%">
              <option value="">— unassigned —</option>
              ${users.map(u => html`
                <option value="${u.id}" ${act.assigned_user_id === u.id ? 'selected' : ''}>${escape(u.display_name ?? u.email)}</option>
              `)}
            </select>
          </div>
          <div>
            <label class="field-label">Due date</label>
            <input type="date" name="due_at" value="${escape(act.due_at ? act.due_at.slice(0, 10) : '')}" style="width:100%">
          </div>
          <div>
            <label class="field-label">Direction</label>
            <select name="direction" style="width:100%">
              <option value="" ${!act.direction ? 'selected' : ''}>—</option>
              <option value="inbound" ${act.direction === 'inbound' ? 'selected' : ''}>Inbound</option>
              <option value="outbound" ${act.direction === 'outbound' ? 'selected' : ''}>Outbound</option>
            </select>
          </div>
        </div>
        <div style="margin-top:0.75rem;">
          <button class="btn primary" type="submit">Save</button>
        </div>
      </form>
    </section>

    ${events.length > 0 ? html`
      <section class="card">
        <h2>History</h2>
        <ul class="activity">
          ${events.map(e => html`
            <li>
              <div class="activity-head">
                <strong>${escape(e.user_name ?? e.user_email ?? 'system')}</strong>
                <span class="activity-type">${escape(e.event_type)}</span>
                <span class="activity-when muted">${escape((e.at ?? '').slice(0, 16).replace('T', ' '))}</span>
              </div>
              <div>${escape(e.summary ?? '')}</div>
            </li>
          `)}
        </ul>
      </section>
    ` : ''}
  `;

  const breadcrumbs = [
    { label: 'Tasks', href: '/activities' },
    { label: act.subject || '(no subject)' },
  ];
  if (act.opportunity_id) {
    breadcrumbs.splice(1, 0, {
      label: act.opp_number ?? 'Opp',
      href: `/opportunities/${act.opportunity_id}`,
    });
  }

  return htmlResponse(layout(act.subject || 'Activity', body, {
    user, env: data?.env, activeNav: '/activities', flash, breadcrumbs,
  }));
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const actId = params.id;

  const before = await one(env.DB, 'SELECT * FROM activities WHERE id = ?', [actId]);
  if (!before) {
    return new Response('Not found', { status: 404 });
  }

  const input = await formBody(request);
  const ts = now();

  const after = {
    type: input.type || before.type,
    subject: (input.subject || '').trim() || before.subject,
    body: (input.body || '').trim() || null,
    direction: input.direction || null,
    status: input.status || before.status,
    due_at: input.due_at || null,
    assigned_user_id: input.assigned_user_id || null,
    opportunity_id: input.opportunity_id || null,
  };

  // If status changed to completed, set completed_at
  let completedAt = before.completed_at;
  if (after.status === 'completed' && before.status !== 'completed') {
    completedAt = ts;
  } else if (after.status !== 'completed') {
    completedAt = null;
  }

  const changes = diff(before, after, UPDATE_FIELDS);

  await batch(env.DB, [
    stmt(env.DB,
      `UPDATE activities
          SET type = ?, subject = ?, body = ?, direction = ?,
              status = ?, due_at = ?, assigned_user_id = ?,
              opportunity_id = ?, completed_at = ?, updated_at = ?
        WHERE id = ?`,
      [after.type, after.subject, after.body, after.direction,
       after.status, after.due_at, after.assigned_user_id,
       after.opportunity_id, completedAt, ts, actId]),
    auditStmt(env.DB, {
      entityType: 'activity',
      entityId: actId,
      eventType: 'updated',
      user,
      summary: `Updated ${after.type}: ${after.subject}`,
      changes,
    }),
  ]);

  return redirectWithFlash(`/activities/${actId}`, 'Saved.');
}
