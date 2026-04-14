// functions/activities/[id]/index.js
//
// GET  /activities/:id  — Activity detail with inline-editable fields
// POST /activities/:id  — (kept for form-based workflow actions)
//
// Fields auto-save via fetch POST to /activities/:id/patch.

import { one, all, stmt, batch } from '../../lib/db.js';
import { auditStmt, diff } from '../../lib/audit.js';
import { layout, htmlResponse, html, escape, raw } from '../../lib/layout.js';
import { now } from '../../lib/ids.js';
import { redirectWithFlash, formBody, readFlash } from '../../lib/http.js';

const TYPE_LABELS = {
  task: 'Task',
  note: 'Note',
  email: 'Email',
  call: 'Call',
  meeting: 'Meeting',
};

const TYPE_OPTIONS = [
  { value: 'task', label: 'Task' },
  { value: 'note', label: 'Note' },
  { value: 'email', label: 'Email' },
  { value: 'call', label: 'Call' },
  { value: 'meeting', label: 'Meeting' },
];

const STATUS_OPTIONS = [
  { value: 'pending', label: 'Pending' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

const DIRECTION_OPTIONS = [
  { value: '', label: '—' },
  { value: 'inbound', label: 'Inbound' },
  { value: 'outbound', label: 'Outbound' },
];

// ---- helpers for inline-editable fields ----------------------------------

function inlineText(field, value, opts = {}) {
  const display = value || opts.placeholder || '—';
  const displayClass = value ? '' : 'muted';
  return html`<span class="ie" data-field="${field}" data-type="text" ${opts.inputType ? `data-input-type="${opts.inputType}"` : ''}>
    <span class="ie-display ${displayClass}">${escape(display)}</span>
  </span>`;
}

function inlineTextarea(field, value, opts = {}) {
  const display = value || opts.placeholder || '—';
  const displayClass = value ? '' : 'muted';
  return html`<span class="ie" data-field="${field}" data-type="textarea">
    <span class="ie-display ${displayClass}">${escape(display)}</span>
    <span class="ie-raw" hidden>${escape(value ?? '')}</span>
  </span>`;
}

function inlineDate(field, value) {
  const display = value ? value.slice(0, 10) : '—';
  const displayClass = value ? '' : 'muted';
  return html`<span class="ie" data-field="${field}" data-type="date">
    <span class="ie-display ${displayClass}">${escape(display)}</span>
    <span class="ie-raw" hidden>${escape(value ? value.slice(0, 10) : '')}</span>
  </span>`;
}

function inlineSelect(field, value, options) {
  const selectedOpt = options.find(o => o.value === (value ?? ''));
  const display = selectedOpt?.label || value || '—';
  const displayClass = value ? '' : 'muted';
  const optJson = JSON.stringify(options);
  return html`<span class="ie" data-field="${field}" data-type="select" data-options='${escape(optJson)}'>
    <span class="ie-display ${displayClass}">${escape(display)}</span>
  </span>`;
}

// ---- GET handler ---------------------------------------------------------

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

  const createdByLabel = act.created_by_name ?? act.created_by_email ?? '—';

  // Build option lists for inline-edit selects
  const oppOptions = [
    { value: '', label: '— none —' },
    ...opportunities.map(o => ({ value: o.id, label: `${o.number} — ${o.title}` })),
  ];
  const userOptions = [
    { value: '', label: '— unassigned —' },
    ...users.map(u => ({ value: u.id, label: u.display_name ?? u.email })),
  ];

  const body = html`
    <section class="card" x-data="actInline('${escape(actId)}')">
      <div class="card-header">
        <div>
          <h1 class="page-title">${inlineText('subject', act.subject, { placeholder: '(no subject)' })}</h1>
          <p class="muted" style="margin:0.15rem 0 0">
            ${inlineSelect('type', act.type, TYPE_OPTIONS)}
            · Created by ${escape(createdByLabel)}
            · ${escape((act.created_at ?? '').slice(0, 16).replace('T', ' '))}
            ${act.status === 'completed' ? html` · <span class="pill pill-success">Completed</span> ${act.completed_at ? escape(act.completed_at.slice(0, 16).replace('T', ' ')) : ''}` : ''}
            ${act.status === 'cancelled' ? html` · <span class="pill pill-locked">Cancelled</span>` : ''}
          </p>
        </div>
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

      <div class="detail-grid" style="display:grid; grid-template-columns:1fr 1fr; gap:0.5rem 1rem; margin-top:0.75rem;">
        <div>
          <span class="field-label">Status</span>
          ${inlineSelect('status', act.status, STATUS_OPTIONS)}
        </div>
        <div>
          <span class="field-label">Direction</span>
          ${inlineSelect('direction', act.direction, DIRECTION_OPTIONS)}
        </div>
        <div>
          <span class="field-label">Assigned to</span>
          ${inlineSelect('assigned_user_id', act.assigned_user_id, userOptions)}
        </div>
        <div>
          <span class="field-label">Due date</span>
          ${inlineDate('due_at', act.due_at)}
        </div>
        <div>
          <span class="field-label">Opportunity</span>
          ${inlineSelect('opportunity_id', act.opportunity_id, oppOptions)}
        </div>
      </div>

      <div style="margin-top:0.75rem;">
        <span class="field-label">Details</span>
        ${inlineTextarea('body', act.body, { placeholder: 'Click to add details...' })}
      </div>
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

    <script>${raw(inlineEditScript())}</script>
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

// ---- POST handler (kept for backward compat, e.g. non-JS fallback) ------

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

  const UPDATE_FIELDS = [
    'type', 'subject', 'body', 'direction', 'status',
    'due_at', 'assigned_user_id', 'opportunity_id',
  ];
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

// ---- Client-side script -------------------------------------------------

function inlineEditScript() {
  return `
function actInline(actId) {
  const patchUrl = '/activities/' + actId + '/patch';
  return {
    saving: false,
    init() {
      this.$el.querySelectorAll('.ie').forEach(el => {
        el.addEventListener('click', () => this.activate(el));
      });
    },
    activate(el) {
      if (el.querySelector('.ie-input')) return; // already active
      const field = el.dataset.field;
      const type = el.dataset.type;
      const display = el.querySelector('.ie-display');
      const rawEl = el.querySelector('.ie-raw');
      const currentValue = rawEl ? rawEl.textContent : (display.classList.contains('muted') ? '' : display.textContent.trim());

      let input;
      if (type === 'select') {
        input = document.createElement('select');
        input.className = 'ie-input';
        const options = JSON.parse(el.dataset.options || '[]');
        options.forEach(o => {
          const opt = document.createElement('option');
          opt.value = o.value;
          opt.textContent = o.label;
          if (o.value === (currentValue || '')) opt.selected = true;
          input.appendChild(opt);
        });
        input.addEventListener('change', () => this.save(el, input));
        input.addEventListener('blur', () => {
          setTimeout(() => this.deactivate(el, input), 150);
        });
      } else if (type === 'textarea') {
        input = document.createElement('textarea');
        input.className = 'ie-input';
        input.rows = 3;
        input.style.fieldSizing = 'content';
        input.style.minHeight = '3rem';
        input.value = currentValue;
        input.addEventListener('blur', () => this.save(el, input));
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { this.deactivate(el, input); }
        });
      } else if (type === 'date') {
        input = document.createElement('input');
        input.type = 'date';
        input.className = 'ie-input';
        input.value = currentValue;
        input.addEventListener('change', () => this.save(el, input));
        input.addEventListener('blur', () => this.save(el, input));
      } else {
        input = document.createElement('input');
        input.type = el.dataset.inputType || 'text';
        input.className = 'ie-input';
        input.value = currentValue;
        input.addEventListener('blur', () => this.save(el, input));
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); this.save(el, input); }
          if (e.key === 'Escape') { this.deactivate(el, input); }
        });
      }

      display.style.display = 'none';
      el.appendChild(input);
      input.focus();
      if (input.select) input.select();
    },
    async save(el, input) {
      const field = el.dataset.field;
      const value = input.value;
      this.deactivate(el, input);

      el.classList.add('ie-saving');
      try {
        const res = await fetch(patchUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ field, value }),
        });
        const data = await res.json();
        if (!data.ok) {
          el.classList.add('ie-error');
          setTimeout(() => el.classList.remove('ie-error'), 2000);
          return;
        }
        // Update display
        const display = el.querySelector('.ie-display');
        const rawEl = el.querySelector('.ie-raw');
        if (el.dataset.type === 'select') {
          const options = JSON.parse(el.dataset.options || '[]');
          const opt = options.find(o => o.value === (data.value || ''));
          display.textContent = opt ? opt.label : (data.value || '\\u2014');
        } else {
          display.textContent = data.value || '\\u2014';
        }
        display.classList.toggle('muted', !data.value);
        if (rawEl) rawEl.textContent = data.value ?? '';

        el.classList.add('ie-saved');
        setTimeout(() => el.classList.remove('ie-saved'), 1200);
      } catch (err) {
        el.classList.add('ie-error');
        setTimeout(() => el.classList.remove('ie-error'), 2000);
      } finally {
        el.classList.remove('ie-saving');
      }
    },
    deactivate(el, input) {
      if (input && input.parentNode === el) el.removeChild(input);
      const display = el.querySelector('.ie-display');
      if (display) display.style.display = '';
    },
  };
}
`;
}
