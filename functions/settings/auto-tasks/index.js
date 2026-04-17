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

// Keep this in sync with the trigger dispatch in functions/lib/auto-tasks.js
// and the call sites in submit.js, stage.js, activities/[id]/patch.js.
export const TRIGGERS = [
  { key: 'quote.issued',               label: 'Quote issued' },
  { key: 'opportunity.stage_changed',  label: 'Opportunity stage changed' },
  { key: 'task.completed',             label: 'Task completed' },
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

  const errText = (k) => (errors[k] ? html`<small class="error">${errors[k]}</small>` : '');

  const body = html`
    <section class="card">
      <div class="card-header">
        <h1>Auto-Task Rules</h1>
        <div style="display:flex;align-items:center;gap:0.5rem">
          <a class="btn" href="/settings">\u2190 Settings</a>
        </div>
      </div>

      <p class="muted">
        Rules that automatically create tasks when an event fires. Each
        rule binds a trigger to a task template plus optional conditions
        and reminder offsets. Edit JSON directly on the detail page.
      </p>

      ${rows.length === 0
        ? html`<p class="muted">No rules yet.</p>`
        : html`
          <table class="data opp-list-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Trigger</th>
                <th>Active</th>
                <th class="num">Fires</th>
                <th>Last fired</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((r) => html`
                <tr ${!r.active ? raw('class="inactive"') : ''}>
                  <td>
                    <a href="/settings/auto-tasks/${escape(r.id)}">${escape(r.name)}</a>
                    ${r.description
                      ? html`<br><small class="muted">${escape(r.description)}</small>`
                      : ''}
                  </td>
                  <td><code>${escape(r.trigger)}</code><br><small class="muted">${escape(triggerLabel(r.trigger))}</small></td>
                  <td>
                    ${r.active
                      ? html`<span class="pill pill-success">Active</span>`
                      : html`<span class="pill pill-locked">Paused</span>`}
                  </td>
                  <td class="num">${r.fire_count ?? 0}</td>
                  <td>${r.last_fired ? escape(formatRelative(r.last_fired)) : html`<span class="muted">—</span>`}</td>
                </tr>
              `)}
            </tbody>
            <tfoot>
              <tr><th colspan="5">${rows.length} rule${rows.length === 1 ? '' : 's'}</th></tr>
            </tfoot>
          </table>
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
