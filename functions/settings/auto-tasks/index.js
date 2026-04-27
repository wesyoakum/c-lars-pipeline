// functions/settings/auto-tasks/index.js
//
// GET  /settings/auto-tasks — list of rules + new-rule form
// POST /settings/auto-tasks — create a rule
//
// Admin-only. Gates on hasRole(user, 'admin').
//
// The list shows one row per rule with:
//   - name (link to detail)
//   - trigger
//   - active (inline toggle)
//   - fires count (from task_rule_fires)
//   - last fired (stringified relative time)
//
// The new-rule form takes name + trigger + optional description, then
// redirects to the detail page where the JSON editors live. Rules are
// created in the "inactive" state so Wes can edit conditions_json +
// task_json before the engine starts firing them.

import { all, one, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { layout, htmlResponse, html, escape, raw } from '../../lib/layout.js';
import { uuid, now } from '../../lib/ids.js';
import { redirectWithFlash, formBody, readFlash } from '../../lib/http.js';
import { hasRole } from '../../lib/auth.js';
import { listScript, listTableHead, listToolbar, rowDataAttrs } from '../../lib/list-table.js';
import { settingsSubNav } from '../../lib/settings-subnav.js';

// Keep this in sync with the trigger dispatch in functions/lib/auto-tasks.js
// and the call sites across the app. Triggers are grouped loosely in
// lifecycle order so the wizard dropdown feels familiar.
//
// Inline triggers — fire synchronously (via waitUntil) from a specific
// route handler. Adding a new inline trigger means: append here, extend
// CONDITION_PATHS / TOKEN_PATHS in ./rule-schema.js, and wire fireEvent
// from the handler.
//
// Cron triggers — fire from the sidecar cron Worker sweep (see
// functions/api/cron/sweep.js and workers/cron/). They carry the entity
// they're sweeping plus any useful context (days_until_expire, etc.).
export const TRIGGERS = [
  // Quote lifecycle
  { key: 'quote.issued',               label: 'Quote issued' },
  { key: 'quote.accepted',             label: 'Quote accepted' },
  { key: 'quote.rejected',             label: 'Quote rejected' },
  { key: 'quote.expired',              label: 'Quote expired' },
  { key: 'quote.revised',              label: 'Quote revised (new revision created)' },
  { key: 'quote.expiring_soon',        label: 'Quote expiring soon (cron)' },
  // Opportunity lifecycle
  { key: 'opportunity.stage_changed',  label: 'Opportunity stage changed' },
  { key: 'opportunity.stalled',        label: 'Opportunity stalled (cron)' },
  // Job lifecycle
  { key: 'oc.issued',                  label: 'OC issued' },
  { key: 'ntp.issued',                 label: 'NTP issued (EPS)' },
  { key: 'authorization.received',     label: 'Customer authorization received (EPS)' },
  { key: 'job.handed_off',             label: 'Job handed off' },
  { key: 'job.completed',              label: 'Job completed' },
  // Price builds
  { key: 'price_build.stale',          label: 'Price build stale (cron)' },
  // Tasks
  { key: 'task.completed',             label: 'Task completed' },
  { key: 'task.overdue',               label: 'Task overdue (cron)' },
  // System
  { key: 'system.error',               label: 'System error' },
];

function triggerLabel(key) {
  return TRIGGERS.find((t) => t.key === key)?.label || key;
}

function formatRelative(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const d = Math.round((Date.now() - t) / 1000);
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  if (d < 604800) return Math.floor(d / 86400) + 'd ago';
  return new Date(iso).toLocaleDateString();
}

export async function onRequestGet(context) {
  return renderList(context, {});
}

async function renderList(context, { values = {}, errors = {} }) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);

  if (!hasRole(user, 'admin')) {
    return htmlResponse(
      layout('Auto-Task Rules', `
        <section class="card">
          <h1>Auto-Task Rules</h1>
          <p>Admin role required to view this page.</p>
        </section>`,
        { user, env: data?.env, activeNav: '/settings' }),
      { status: 403 }
    );
  }

  const rows = await all(
    env.DB,
    `SELECT r.id, r.name, r.description, r.trigger, r.active, r.updated_at,
            (SELECT COUNT(*) FROM task_rule_fires f WHERE f.rule_id = r.id) AS fire_count,
            (SELECT MAX(f.fired_at) FROM task_rule_fires f WHERE f.rule_id = r.id) AS last_fired
       FROM task_rules r
      ORDER BY r.active DESC, r.name`
  );

  const columns = [
    { key: 'name',        label: 'Name',        sort: 'text',   filter: 'text',   default: true  },
    { key: 'description', label: 'Description', sort: 'text',   filter: 'text',   default: true  },
    { key: 'trigger',     label: 'Trigger',     sort: 'text',   filter: 'select', default: true  },
    { key: 'status',      label: 'Status',      sort: 'text',   filter: 'select', default: true  },
    { key: 'fires',       label: 'Fires',       sort: 'number', filter: 'range',  default: true  },
    { key: 'last_fired',  label: 'Last fired',  sort: 'text',   filter: 'text',   default: true  },
    { key: 'updated',     label: 'Updated',     sort: 'text',   filter: 'text',   default: false },
  ];

  const rowData = rows.map((r) => ({
    id: r.id,
    name: r.name ?? '',
    description: r.description ?? '',
    trigger: triggerLabel(r.trigger),
    trigger_key: r.trigger,
    status: r.active ? 'Active' : 'Paused',
    active: r.active,
    fires: r.fire_count ?? 0,
    last_fired: r.last_fired ? formatRelative(r.last_fired) : '',
    last_fired_iso: r.last_fired ?? '',
    updated: (r.updated_at ?? '').slice(0, 10),
  }));

  const errText = (k) => (errors[k] ? html`<small class="error">${errors[k]}</small>` : '');

  const body = html`
    ${settingsSubNav('auto-tasks', true)}

    <section class="card">
      <div class="card-header">
        <h1>Auto-Task Rules</h1>
        ${listToolbar({ id: 'auto-tasks', count: rows.length, columns })}
      </div>

      <p class="muted">
        Rules that automatically create tasks when an event fires. Each
        rule binds a trigger to a task template plus optional conditions
        and reminder offsets. Edit JSON directly on the detail page.
      </p>

      ${rows.length === 0
        ? html`<p class="muted">No rules yet.</p>`
        : html`
          <div class="opp-list" data-columns="${escape(JSON.stringify(columns))}">
            <table class="data opp-list-table">
              ${listTableHead(columns, rowData)}
              <tbody data-role="rows">
                ${rowData.map((r) => html`
                  <tr data-row-id="${escape(r.id)}"
                      ${raw(rowDataAttrs(columns, r))}
                      ${!r.active ? raw('class="inactive"') : ''}>
                    <td class="col-name" data-col="name">
                      <a href="/settings/auto-tasks/${escape(r.id)}">${escape(r.name)}</a>
                    </td>
                    <td class="col-description" data-col="description">${escape(r.description)}</td>
                    <td class="col-trigger" data-col="trigger">
                      ${escape(r.trigger)}
                      <br><small class="muted"><code>${escape(r.trigger_key)}</code></small>
                    </td>
                    <td class="col-status" data-col="status">
                      ${r.active
                        ? html`<span class="pill pill-success">Active</span>`
                        : html`<span class="pill pill-locked">Paused</span>`}
                    </td>
                    <td class="col-fires num" data-col="fires">${r.fires}</td>
                    <td class="col-last_fired" data-col="last_fired">
                      ${r.last_fired
                        ? html`<span title="${escape(r.last_fired_iso)}">${escape(r.last_fired)}</span>`
                        : html`<span class="muted">—</span>`}
                    </td>
                    <td class="col-updated" data-col="updated">${escape(r.updated)}</td>
                  </tr>
                `)}
              </tbody>
              <tfoot>
                <tr><th colspan="${columns.length}">${rows.length} rule${rows.length === 1 ? '' : 's'}</th></tr>
              </tfoot>
            </table>
          </div>
          <script>${raw(listScript('pipeline.autoTasks.v1', 'name', 'asc'))}</script>
        `}

      <h2 class="section-h">Add rule</h2>
      <p class="muted">
        New rules are created paused. Pick a trigger, give it a name,
        then edit conditions + task template on the detail page before
        activating.
      </p>
      <form method="post" action="/settings/auto-tasks" class="inline-form">
        <div class="field">
          <label>Name</label>
          <input type="text" name="name" value="${escape(values.name ?? '')}"
                 required autofocus placeholder="e.g. Remind me 3 days before quote expires">
          ${errText('name')}
        </div>
        <div class="field">
          <label>Trigger</label>
          <select name="trigger" required>
            ${TRIGGERS.map((t) => html`
              <option value="${escape(t.key)}" ${values.trigger === t.key ? 'selected' : ''}>
                ${escape(t.label)} (${escape(t.key)})
              </option>
            `)}
          </select>
          ${errText('trigger')}
        </div>
        <div class="field">
          <label>Description</label>
          <input type="text" name="description" value="${escape(values.description ?? '')}"
                 placeholder="Optional — one-line reminder of what this rule is for">
        </div>
        <button class="btn primary" type="submit">Add rule</button>
      </form>
    </section>
  `;

  return htmlResponse(
    layout('Auto-Task Rules', body, {
      user,
      env: data?.env,
      activeNav: '/settings',
      flash: readFlash(url),
      breadcrumbs: [
        { label: 'Settings', href: '/settings' },
        { label: 'Auto-Task Rules' },
      ],
    })
  );
}

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;

  if (!hasRole(user, 'admin')) {
    return new Response('Admin role required', { status: 403 });
  }

  const input = await formBody(request);

  const errors = {};
  const name = (input.name ?? '').trim();
  if (!name) errors.name = 'Name is required.';

  const triggerKey = (input.trigger ?? '').trim();
  if (!triggerKey || !TRIGGERS.some((t) => t.key === triggerKey)) {
    errors.trigger = 'Pick a valid trigger.';
  }

  if (Object.keys(errors).length) {
    return renderList(context, { values: input, errors });
  }

  const id = uuid();
  const ts = now();
  const description = (input.description ?? '').trim() || null;

  // Seed an empty task template so the detail-page editors have
  // something to parse. User fills this in before activating.
  const starterTask = JSON.stringify({
    title: 'TODO: task title with {payload.tokens}',
    body: null,
    assignee: 'trigger.user',
    due_at: '+1d@cob',
    reminders: [],
    link: null,
  }, null, 2);

  await batch(env.DB, [
    stmt(
      env.DB,
      `INSERT INTO task_rules
         (id, name, description, trigger, conditions_json, task_json, tz, active,
          created_at, updated_at, created_by_user_id)
       VALUES (?, ?, ?, ?, NULL, ?, 'America/Chicago', 0, ?, ?, ?)`,
      [id, name, description, triggerKey, starterTask, ts, ts, user?.id ?? null]
    ),
    auditStmt(env.DB, {
      entityType: 'task_rule',
      entityId: id,
      eventType: 'created',
      user,
      summary: `Created auto-task rule "${name}" (paused)`,
      changes: { name, trigger: triggerKey, description },
    }),
  ]);

  return redirectWithFlash(
    `/settings/auto-tasks/${id}`,
    `Created rule "${name}" — edit conditions + task template then activate.`
  );
}
