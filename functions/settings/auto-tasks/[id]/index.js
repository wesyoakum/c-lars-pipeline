// functions/settings/auto-tasks/[id]/index.js
//
// GET /settings/auto-tasks/:id — rule detail + editor
//
// Renders:
//   - inline-editable name, description, tz (auto-save on blur)
//   - trigger dropdown (inline-save on change)
//   - active toggle (inline-save on change)
//   - Conditions builder: structured row-based UI (path + op + value) with
//     dropdowns driven by rule-schema.js. Advanced users can flip to raw
//     JSON via a "Show raw JSON" toggle.
//   - Task template builder: title / body / assignee / due_at / reminders
//     / link — each with plain-English controls and token pickers. Same
//     raw-JSON escape hatch.
//   - recent fires table (last 10) + fire/skip counts
//   - delete button (confirm)
//
// Both builders serialize their structured state back to JSON and POST
// to ./patch.js with field = 'conditions_json' | 'task_json'. The patch
// endpoint is unchanged — it still just validates JSON parses.

import { one, all } from '../../../lib/db.js';
import { layout, htmlResponse, html, escape, raw } from '../../../lib/layout.js';
import { readFlash } from '../../../lib/http.js';
import { hasRole } from '../../../lib/auth.js';
import { TRIGGERS } from '../index.js';
import {
  CONDITION_PATHS,
  TOKEN_PATHS,
  STAGE_KEYS,
  TRANSACTION_TYPES,
  QUOTE_TYPES,
  ERROR_CODES,
  ASSIGNEE_OPTIONS,
  LINK_OPTIONS,
} from '../rule-schema.js';

function triggerLabel(key) {
  return TRIGGERS.find((t) => t.key === key)?.label || key;
}

function formatLocal(iso) {
  if (!iso) return '';
  return iso.slice(0, 16).replace('T', ' ');
}

export async function onRequestGet(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const id = params.id;

  if (!hasRole(user, 'admin')) {
    return htmlResponse(
      layout('Auto-Task Rule', `
        <section class="card">
          <h1>Auto-Task Rule</h1>
          <p>Admin role required.</p>
        </section>`,
        { user, env: data?.env, activeNav: '/settings' }),
      { status: 403 }
    );
  }

  const rule = await one(
    env.DB,
    `SELECT id, name, description, trigger, conditions_json, task_json, tz,
            active, created_at, updated_at, created_by_user_id
       FROM task_rules WHERE id = ?`,
    [id]
  );
  if (!rule) {
    return htmlResponse(
      layout('Not found', `
        <section class="card">
          <h1>Rule not found</h1>
          <p><a href="/settings/auto-tasks">Back to rules</a></p>
        </section>`,
        { user, env: data?.env, activeNav: '/settings' }),
      { status: 404 }
    );
  }

  // Last 10 fires + overall counts.
  const fires = await all(
    env.DB,
    `SELECT f.id, f.event_key, f.fired_at, f.task_id,
            a.subject AS task_subject, a.status AS task_status
       FROM task_rule_fires f
       LEFT JOIN activities a ON a.id = f.task_id
      WHERE f.rule_id = ?
      ORDER BY f.fired_at DESC
      LIMIT 10`,
    [id]
  );
  const counts = await one(
    env.DB,
    'SELECT COUNT(*) AS n FROM task_rule_fires WHERE rule_id = ?',
    [id]
  );

  // Pretty-print the JSON blobs for the raw editor fallback.
  function prettify(s) {
    if (!s) return '';
    try { return JSON.stringify(JSON.parse(s), null, 2); }
    catch { return s; }
  }
  const conditionsPretty = prettify(rule.conditions_json);
  const taskPretty = prettify(rule.task_json);

  // Per-trigger hint data for the wizard (passed to Alpine as JSON).
  const conditionPathsForTrigger = CONDITION_PATHS[rule.trigger] || [];
  const tokenPathsForTrigger = TOKEN_PATHS[rule.trigger] || [];

  const schemaForClient = {
    conditionPaths: conditionPathsForTrigger,
    tokenPaths: tokenPathsForTrigger,
    stages: STAGE_KEYS,
    transactionTypes: TRANSACTION_TYPES,
    quoteTypes: QUOTE_TYPES,
    errorCodes: ERROR_CODES,
    assigneeOptions: ASSIGNEE_OPTIONS,
    linkOptions: LINK_OPTIONS,
  };

  const body = html`
    <section class="card" x-data="ruleInline('${escape(id)}')">
      <div class="card-header">
        <div>
          <h1 class="page-title">
            <span class="ie" data-field="name" data-type="text">
              <span class="ie-display">${escape(rule.name)}</span>
            </span>
          </h1>
          <p class="muted" style="margin:0.15rem 0 0">
            ${rule.active
              ? html`<span class="pill pill-success">Active</span>`
              : html`<span class="pill pill-locked">Paused</span>`}
            · Created ${escape(formatLocal(rule.created_at))}
            · Updated ${escape(formatLocal(rule.updated_at))}
          </p>
        </div>
        <div class="header-actions" style="display:flex; gap:0.5rem; align-items:center;">
          <label class="toggle-label" style="display:flex; align-items:center; gap:0.4rem; cursor:pointer; font-size:0.85rem;">
            <input type="checkbox" ${rule.active ? 'checked' : ''}
                   @change="toggleActive($event.target.checked)">
            Active
          </label>
          <a class="btn btn-sm" href="/settings/auto-tasks">All rules</a>
          <form method="post" action="/settings/auto-tasks/${escape(id)}/delete"
                onsubmit="return confirm('Delete this rule? Tasks already created by it will keep their history but lose the rule link.')">
            <button class="btn btn-sm danger" type="submit">Delete</button>
          </form>
        </div>
      </div>

      <div class="detail-grid" style="display:grid; grid-template-columns:1fr 1fr; gap:0.5rem 1rem; margin-top:0.75rem;">
        <div>
          <span class="field-label">Trigger</span>
          <select @change="saveSelect('trigger', $event.target.value); setTimeout(() => location.reload(), 400);" style="width:100%;">
            ${TRIGGERS.map((t) => html`
              <option value="${escape(t.key)}" ${rule.trigger === t.key ? 'selected' : ''}>
                ${escape(t.label)} (${escape(t.key)})
              </option>
            `)}
          </select>
          <small class="muted">Changing the trigger reloads so the builders pick up the right fields.</small>
        </div>
        <div>
          <span class="field-label">Timezone</span>
          <span class="ie" data-field="tz" data-type="text">
            <span class="ie-display">${escape(rule.tz || 'America/Chicago')}</span>
          </span>
        </div>
        <div style="grid-column: 1 / -1;">
          <span class="field-label">Description</span>
          <span class="ie" data-field="description" data-type="text">
            <span class="ie-display ${rule.description ? '' : 'muted'}">${escape(rule.description || 'Click to add description...')}</span>
            <span class="ie-raw" hidden>${escape(rule.description ?? '')}</span>
          </span>
        </div>
      </div>

      <h2 class="section-h" style="margin-top:1.5rem;">Conditions</h2>
      <p class="muted">
        Only fire this rule when every condition matches. Leave empty to
        fire on every <code>${escape(rule.trigger)}</code> event.
      </p>
      <div x-data="conditionsBuilder(${escape(JSON.stringify({
        initialJson: conditionsPretty,
        schema: schemaForClient,
      }))})">
        <template x-if="rows.length === 0">
          <p class="muted"><em>No conditions — rule fires on every event.</em></p>
        </template>

        <template x-for="(row, idx) in rows" :key="idx">
          <div class="cond-row" style="display:grid; grid-template-columns: 2fr 1.2fr 2fr auto; gap:0.5rem; align-items:start; margin-bottom:0.4rem;">
            <div>
              <select x-model="row.path" @change="onPathChange(idx)" style="width:100%;">
                <option value="">— pick a field —</option>
                <template x-for="p in schema.conditionPaths" :key="p.path">
                  <option :value="p.path" x-text="p.label + ' (' + p.path + ')'"></option>
                </template>
              </select>
            </div>
            <div>
              <select x-model="row.op" @change="onOpChange(idx)" style="width:100%;">
                <option value="eq">equals</option>
                <option value="neq">does not equal</option>
                <option value="in">is one of</option>
                <option value="exists_true">is set</option>
                <option value="exists_false">is not set</option>
              </select>
            </div>
            <div>
              <template x-if="row.op === 'exists_true' || row.op === 'exists_false'">
                <span class="muted" style="font-size:0.85rem;">(no value needed)</span>
              </template>
              <template x-if="row.op !== 'exists_true' && row.op !== 'exists_false'">
                <div>
                  <template x-if="valueHintsFor(row.path).length > 0 && row.op !== 'in'">
                    <select x-model="row.value" style="width:100%;">
                      <option value="">— pick a value —</option>
                      <template x-for="v in valueHintsFor(row.path)" :key="v.key">
                        <option :value="v.key" x-text="v.label + ' (' + v.key + ')'"></option>
                      </template>
                    </select>
                  </template>
                  <template x-if="valueHintsFor(row.path).length > 0 && row.op === 'in'">
                    <div>
                      <template x-for="v in valueHintsFor(row.path)" :key="v.key">
                        <label style="display:inline-flex; align-items:center; gap:0.25rem; margin-right:0.6rem; font-size:0.85rem;">
                          <input type="checkbox" :value="v.key"
                                 :checked="(row.valueList || []).includes(v.key)"
                                 @change="toggleInValue(idx, v.key, $event.target.checked)">
                          <span x-text="v.label"></span>
                        </label>
                      </template>
                    </div>
                  </template>
                  <template x-if="valueHintsFor(row.path).length === 0 && row.op !== 'in'">
                    <input type="text" x-model="row.value" style="width:100%;" placeholder="value">
                  </template>
                  <template x-if="valueHintsFor(row.path).length === 0 && row.op === 'in'">
                    <input type="text" x-model="row.valueCsv" style="width:100%;" placeholder="comma,separated,values">
                  </template>
                </div>
              </template>
            </div>
            <div>
              <button class="btn btn-sm" type="button" @click="removeRow(idx)" title="Remove">×</button>
            </div>
          </div>
        </template>

        <div style="display:flex; gap:0.5rem; align-items:center; margin-top:0.5rem;">
          <button class="btn btn-sm" type="button" @click="addRow()">+ Add condition</button>
          <button class="btn primary btn-sm" type="button" @click="save()" :disabled="saving">Save conditions</button>
          <span x-show="status" x-text="status" :style="'color:' + (error ? '#b00' : '#080')"></span>
          <label style="margin-left:auto; font-size:0.85rem;">
            <input type="checkbox" x-model="showRaw"> Show raw JSON
          </label>
        </div>

        <div x-show="showRaw" style="margin-top:0.75rem;">
          <textarea class="json-editor" rows="6" x-model="rawJson"
                    placeholder='{"opportunity.stage":"closed_won"}'></textarea>
          <div style="display:flex; gap:0.5rem; margin-top:0.4rem;">
            <button class="btn btn-sm" type="button" @click="loadFromRaw()">Apply to builder</button>
            <button class="btn btn-sm primary" type="button" @click="saveRaw()" :disabled="saving">Save raw</button>
            <small class="muted">Advanced: supports primitive, <code>{"eq":v}</code>, <code>{"neq":v}</code>, <code>{"in":[...]}</code>, <code>{"exists":true|false}</code>.</small>
          </div>
        </div>
      </div>

      <h2 class="section-h" style="margin-top:1.5rem;">Task template</h2>
      <p class="muted">
        What task to create when the rule fires. Use
        <code>{path.to.field}</code> in title/body to substitute payload
        values.
      </p>
      <div x-data="taskBuilder(${escape(JSON.stringify({
        initialJson: taskPretty,
        schema: schemaForClient,
      }))})">
        <div style="display:grid; grid-template-columns:1fr; gap:0.6rem;">
          <div>
            <label class="field-label">Title <small class="muted">(required)</small></label>
            <div style="display:flex; gap:0.4rem;">
              <input type="text" x-model="task.title" x-ref="titleInput" style="flex:1;" placeholder="e.g. Follow up on quote {quote.number}">
              <select @change="insertToken($refs.titleInput, $event.target.value); $event.target.value='';">
                <option value="">Insert token…</option>
                <template x-for="t in schema.tokenPaths" :key="t.path">
                  <option :value="'{' + t.path + '}'" x-text="t.label + ' ({' + t.path + '})'"></option>
                </template>
              </select>
            </div>
          </div>

          <div>
            <label class="field-label">Body <small class="muted">(optional)</small></label>
            <div style="display:flex; gap:0.4rem; align-items:start;">
              <textarea x-model="task.body" x-ref="bodyInput" rows="3" style="flex:1;" placeholder="Details shown in the task body..."></textarea>
              <select @change="insertToken($refs.bodyInput, $event.target.value); $event.target.value='';">
                <option value="">Insert token…</option>
                <template x-for="t in schema.tokenPaths" :key="t.path">
                  <option :value="'{' + t.path + '}'" x-text="t.label + ' ({' + t.path + '})'"></option>
                </template>
              </select>
            </div>
          </div>

          <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.6rem;">
            <div>
              <label class="field-label">Assignee</label>
              <select x-model="task.assigneePreset" style="width:100%;">
                <template x-for="o in schema.assigneeOptions" :key="o.key">
                  <option :value="o.key" x-text="o.label"></option>
                </template>
              </select>
              <template x-if="task.assigneePreset === 'specific'">
                <input type="text" x-model="task.assigneeUserId" style="width:100%; margin-top:0.3rem;" placeholder="User UUID (paste here)">
              </template>
            </div>

            <div>
              <label class="field-label">Link task to</label>
              <select x-model="task.link" style="width:100%;">
                <template x-for="o in schema.linkOptions" :key="o.key">
                  <option :value="o.key" x-text="o.label"></option>
                </template>
              </select>
            </div>
          </div>

          <div>
            <label class="field-label">Due when?</label>
            <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:0.5rem; align-items:start;">
              <div>
                <select x-model="task.dueMode" style="width:100%;">
                  <option value="none">No due date</option>
                  <option value="relative_days">In N days</option>
                  <option value="relative_hours">In N hours</option>
                  <option value="tomorrow">Tomorrow</option>
                  <option value="next_friday">Next Friday</option>
                  <option value="next_monday">Next Monday</option>
                  <option value="custom">Custom DSL…</option>
                </select>
              </div>
              <div>
                <template x-if="task.dueMode === 'relative_days' || task.dueMode === 'relative_hours'">
                  <input type="number" min="1" x-model.number="task.dueN" style="width:100%;" placeholder="N">
                </template>
                <template x-if="task.dueMode === 'custom'">
                  <input type="text" x-model="task.dueCustom" style="width:100%;" placeholder="e.g. +3d@cob or next_friday@09:00">
                </template>
              </div>
              <div>
                <template x-if="task.dueMode !== 'none' && task.dueMode !== 'custom' && task.dueMode !== 'relative_hours'">
                  <select x-model="task.dueTime" style="width:100%;">
                    <option value="cob">End of day (COB 17:00)</option>
                    <option value="09:00">09:00</option>
                    <option value="12:00">12:00</option>
                    <option value="15:00">15:00</option>
                    <option value="">(no time)</option>
                  </select>
                </template>
              </div>
            </div>
            <small class="muted">Computed DSL: <code x-text="computedDueDsl() || '(none)'"></code></small>
          </div>

          <div>
            <label class="field-label">Reminders</label>
            <template x-if="task.reminders.length === 0">
              <p class="muted" style="margin:0.25rem 0;"><em>No reminders.</em></p>
            </template>
            <template x-for="(r, ri) in task.reminders" :key="ri">
              <div style="display:grid; grid-template-columns: 1fr 1fr 1fr auto; gap:0.4rem; align-items:center; margin-bottom:0.3rem;">
                <select x-model="r.mode" @change="reminderModeChanged(ri)">
                  <option value="relative_days">N days before</option>
                  <option value="relative_hours">N hours before</option>
                  <option value="custom">Custom DSL…</option>
                </select>
                <template x-if="r.mode !== 'custom'">
                  <input type="number" min="1" x-model.number="r.n" placeholder="N">
                </template>
                <template x-if="r.mode === 'custom'">
                  <input type="text" x-model="r.custom" placeholder="e.g. -1d@09:00">
                </template>
                <template x-if="r.mode === 'relative_days'">
                  <select x-model="r.time">
                    <option value="09:00">at 09:00</option>
                    <option value="12:00">at 12:00</option>
                    <option value="cob">at COB</option>
                    <option value="">(no time)</option>
                  </select>
                </template>
                <template x-if="r.mode !== 'relative_days'">
                  <span></span>
                </template>
                <button class="btn btn-sm" type="button" @click="removeReminder(ri)">×</button>
              </div>
            </template>
            <button class="btn btn-sm" type="button" @click="addReminder()">+ Add reminder</button>
            <small class="muted" style="margin-left:0.6rem;">DSL previews: <code x-text="computedReminderDsls().join(', ') || '(none)'"></code></small>
          </div>
        </div>

        <div style="display:flex; gap:0.5rem; align-items:center; margin-top:0.75rem;">
          <button class="btn primary" type="button" @click="save()" :disabled="saving || !task.title">Save task template</button>
          <span x-show="status" x-text="status" :style="'color:' + (error ? '#b00' : '#080')"></span>
          <label style="margin-left:auto; font-size:0.85rem;">
            <input type="checkbox" x-model="showRaw"> Show raw JSON
          </label>
        </div>

        <div x-show="showRaw" style="margin-top:0.75rem;">
          <textarea class="json-editor" rows="10" x-model="rawJson"
                    placeholder='{"title":"..."}'></textarea>
          <div style="display:flex; gap:0.5rem; margin-top:0.4rem;">
            <button class="btn btn-sm" type="button" @click="loadFromRaw()">Apply to builder</button>
            <button class="btn btn-sm primary" type="button" @click="saveRaw()" :disabled="saving">Save raw</button>
          </div>
        </div>
      </div>

      <h2 class="section-h" style="margin-top:1.5rem;">Recent fires</h2>
      <p class="muted">
        Total fires: <strong>${counts?.n ?? 0}</strong>. Showing last 10.
      </p>
      ${fires.length === 0
        ? html`<p class="muted">This rule hasn't fired yet.</p>`
        : html`
          <table class="data opp-list-table">
            <thead>
              <tr>
                <th>Fired at</th>
                <th>Event key</th>
                <th>Created task</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${fires.map((f) => html`
                <tr>
                  <td>${escape(formatLocal(f.fired_at))}</td>
                  <td><code>${escape(f.event_key)}</code></td>
                  <td>
                    ${f.task_id
                      ? html`<a href="/activities/${escape(f.task_id)}">${escape(f.task_subject || '(task)')}</a>`
                      : html`<span class="muted">(none)</span>`}
                  </td>
                  <td>${escape(f.task_status || '')}</td>
                </tr>
              `)}
            </tbody>
          </table>
        `}
    </section>

    <style>${raw(editorStyles())}</style>
    <script>${raw(inlineEditScript())}</script>
  `;

  return htmlResponse(
    layout(rule.name || 'Auto-Task Rule', body, {
      user,
      env: data?.env,
      activeNav: '/settings',
      flash: readFlash(url),
      breadcrumbs: [
        { label: 'Settings', href: '/settings' },
        { label: 'Auto-Task Rules', href: '/settings/auto-tasks' },
        { label: rule.name || '(unnamed)' },
      ],
    })
  );
}

function editorStyles() {
  return `
    .json-editor {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.85rem;
      width: 100%;
      padding: 0.5rem;
      border: 2px solid #ccc;
      border-radius: 4px;
      resize: vertical;
      box-sizing: border-box;
    }
    .cond-row select, .cond-row input { font-size: 0.9rem; }
  `;
}

function inlineEditScript() {
  return `
function ruleInline(ruleId) {
  const patchUrl = '/settings/auto-tasks/' + ruleId + '/patch';
  return {
    init() {
      this.$el.querySelectorAll('.ie').forEach(el => {
        el.addEventListener('click', () => this.activate(el));
      });
    },
    activate(el) {
      if (el.querySelector('.ie-input')) return;
      const type = el.dataset.type;
      const display = el.querySelector('.ie-display');
      const rawEl = el.querySelector('.ie-raw');
      const currentValue = rawEl
        ? rawEl.textContent
        : (display.classList.contains('muted') ? '' : display.textContent.trim());

      let input;
      if (type === 'textarea') {
        input = document.createElement('textarea');
        input.className = 'ie-input';
        input.rows = 3;
        input.value = currentValue;
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.className = 'ie-input';
        input.value = currentValue;
      }
      input.addEventListener('blur', () => this.save(el, input));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && type !== 'textarea') { e.preventDefault(); this.save(el, input); }
        if (e.key === 'Escape') { this.deactivate(el, input); }
      });

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
        const d = await res.json();
        if (!d.ok) {
          el.classList.add('ie-error');
          alert(d.error || 'Error saving');
          setTimeout(() => el.classList.remove('ie-error'), 2000);
          return;
        }
        const display = el.querySelector('.ie-display');
        const rawEl = el.querySelector('.ie-raw');
        display.textContent = d.value || '\\u2014';
        display.classList.toggle('muted', !d.value);
        if (rawEl) rawEl.textContent = d.value ?? '';

        el.classList.add('ie-saved');
        setTimeout(() => el.classList.remove('ie-saved'), 1200);
      } catch (err) {
        el.classList.add('ie-error');
        alert('Network error saving');
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
    async saveSelect(field, value) {
      try {
        const res = await fetch(patchUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ field, value }),
        });
        const d = await res.json();
        if (!d.ok) { alert(d.error || 'Error saving'); return; }
      } catch (err) {
        alert('Network error saving');
      }
    },
    async toggleActive(checked) {
      try {
        const res = await fetch(patchUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ field: 'active', value: checked ? '1' : '0' }),
        });
        const d = await res.json();
        if (!d.ok) { alert(d.error || 'Error saving'); return; }
        location.reload();
      } catch (err) {
        alert('Network error saving');
      }
    },
  };
}

// Shared POST helper — both builders hit ./patch with (field, value).
async function patchRule(field, value) {
  const res = await fetch(window.location.pathname + '/patch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ field, value }),
  });
  return res.json();
}

// Conditions builder — deserialize existing JSON into rows, re-serialize
// on save. Supports primitive, {eq}, {neq}, {in:[...]}, {exists:bool}.
function conditionsBuilder(cfg) {
  return {
    schema: cfg.schema,
    rows: [],
    rawJson: cfg.initialJson || '',
    showRaw: false,
    saving: false,
    status: '',
    error: false,
    init() {
      this.rows = this.deserialize(cfg.initialJson);
    },
    deserialize(jsonStr) {
      if (!jsonStr || !jsonStr.trim()) return [];
      let obj;
      try { obj = JSON.parse(jsonStr); } catch { return []; }
      if (!obj || typeof obj !== 'object') return [];
      const out = [];
      for (const [path, spec] of Object.entries(obj)) {
        if (spec && typeof spec === 'object' && !Array.isArray(spec)) {
          if ('in' in spec && Array.isArray(spec.in)) {
            out.push({ path, op: 'in', valueList: spec.in.map(String), valueCsv: spec.in.join(','), value: '' });
          } else if ('neq' in spec) {
            out.push({ path, op: 'neq', value: String(spec.neq ?? '') });
          } else if ('eq' in spec) {
            out.push({ path, op: 'eq', value: String(spec.eq ?? '') });
          } else if ('exists' in spec) {
            out.push({ path, op: spec.exists ? 'exists_true' : 'exists_false', value: '' });
          } else {
            // Unknown shape — drop into raw value so user can see it.
            out.push({ path, op: 'eq', value: JSON.stringify(spec) });
          }
        } else {
          out.push({ path, op: 'eq', value: String(spec ?? '') });
        }
      }
      return out;
    },
    serialize() {
      const obj = {};
      for (const r of this.rows) {
        if (!r.path) continue;
        if (r.op === 'eq') {
          obj[r.path] = coerce(r.value);
        } else if (r.op === 'neq') {
          obj[r.path] = { neq: coerce(r.value) };
        } else if (r.op === 'in') {
          let list = r.valueList;
          if (!list || !list.length) {
            list = (r.valueCsv || '').split(',').map(s => s.trim()).filter(Boolean);
          }
          obj[r.path] = { in: list };
        } else if (r.op === 'exists_true') {
          obj[r.path] = { exists: true };
        } else if (r.op === 'exists_false') {
          obj[r.path] = { exists: false };
        }
      }
      return obj;
    },
    valueHintsFor(path) {
      const p = (this.schema.conditionPaths || []).find(x => x.path === path);
      if (!p || !p.values) return [];
      if (Array.isArray(p.values)) return p.values.map(v => ({ key: v, label: v }));
      if (p.values === 'stages') return this.schema.stages;
      if (p.values === 'transaction_types') return this.schema.transactionTypes;
      if (p.values === 'quote_types') return this.schema.quoteTypes;
      if (p.values === 'error_codes') return this.schema.errorCodes;
      return [];
    },
    addRow() {
      this.rows.push({ path: '', op: 'eq', value: '', valueList: [], valueCsv: '' });
    },
    removeRow(i) { this.rows.splice(i, 1); },
    onPathChange(i) {
      // Reset value when the path changes so stale values don't leak.
      this.rows[i].value = '';
      this.rows[i].valueList = [];
      this.rows[i].valueCsv = '';
    },
    onOpChange(i) {
      if (this.rows[i].op === 'in' && !Array.isArray(this.rows[i].valueList)) {
        this.rows[i].valueList = [];
      }
    },
    toggleInValue(i, key, checked) {
      const row = this.rows[i];
      if (!Array.isArray(row.valueList)) row.valueList = [];
      const set = new Set(row.valueList);
      if (checked) set.add(key); else set.delete(key);
      row.valueList = Array.from(set);
    },
    loadFromRaw() {
      try {
        const obj = this.rawJson && this.rawJson.trim() ? JSON.parse(this.rawJson) : {};
        this.rows = this.deserialize(JSON.stringify(obj));
        this.status = 'Loaded into builder.';
        this.error = false;
        setTimeout(() => { this.status = ''; }, 1500);
      } catch (err) {
        this.status = 'Invalid JSON: ' + err.message;
        this.error = true;
      }
    },
    async save() {
      this.saving = true;
      this.status = 'Saving...';
      this.error = false;
      try {
        const obj = this.serialize();
        const value = Object.keys(obj).length === 0 ? '' : JSON.stringify(obj, null, 2);
        const d = await patchRule('conditions_json', value);
        if (d.ok) {
          this.status = 'Saved';
          this.rawJson = value;
          setTimeout(() => { this.status = ''; }, 1500);
        } else {
          this.status = 'Error: ' + (d.error || 'save failed');
          this.error = true;
        }
      } catch (err) {
        this.status = 'Network error';
        this.error = true;
      } finally {
        this.saving = false;
      }
    },
    async saveRaw() {
      this.saving = true;
      this.status = 'Saving...';
      this.error = false;
      try {
        const d = await patchRule('conditions_json', (this.rawJson || '').trim());
        if (d.ok) {
          this.status = 'Saved';
          this.rows = this.deserialize(this.rawJson);
          setTimeout(() => { this.status = ''; }, 1500);
        } else {
          this.status = 'Error: ' + (d.error || 'save failed');
          this.error = true;
        }
      } catch (err) {
        this.status = 'Network error';
        this.error = true;
      } finally {
        this.saving = false;
      }
    },
  };
}

function coerce(s) {
  // Coerce common primitive strings ("1","0","true","false","null") so
  // equality checks against boolean-ish fields (is_hybrid) still work.
  if (s === '' || s == null) return '';
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (/^-?\\d+$/.test(s)) return Number(s);
  return s;
}

// Task template builder — structured due_at / reminders / link / assignee.
function taskBuilder(cfg) {
  return {
    schema: cfg.schema,
    task: {
      title: '',
      body: '',
      assigneePreset: 'trigger.user',
      assigneeUserId: '',
      dueMode: 'none',
      dueN: 1,
      dueTime: 'cob',
      dueCustom: '',
      reminders: [],
      link: '',
    },
    rawJson: cfg.initialJson || '',
    showRaw: false,
    saving: false,
    status: '',
    error: false,
    init() {
      this.task = this.deserialize(cfg.initialJson);
    },
    deserialize(jsonStr) {
      const base = {
        title: '',
        body: '',
        assigneePreset: 'trigger.user',
        assigneeUserId: '',
        dueMode: 'none',
        dueN: 1,
        dueTime: 'cob',
        dueCustom: '',
        reminders: [],
        link: '',
      };
      if (!jsonStr || !jsonStr.trim()) return base;
      let obj;
      try { obj = JSON.parse(jsonStr); } catch { return base; }
      if (!obj || typeof obj !== 'object') return base;
      base.title = obj.title ?? '';
      base.body = obj.body ?? '';
      // Assignee: either a preset key or "user:<uuid>"
      const a = obj.assignee ?? 'trigger.user';
      if (typeof a === 'string' && a.startsWith('user:')) {
        base.assigneePreset = 'specific';
        base.assigneeUserId = a.slice(5);
      } else {
        base.assigneePreset = a || 'trigger.user';
      }
      base.link = obj.link ?? '';
      // due_at parsing
      const d = obj.due_at;
      if (!d) {
        base.dueMode = 'none';
      } else if (typeof d === 'string') {
        const rel = d.match(/^\\+(\\d+)d(?:@(cob|\\d{2}:\\d{2}))?$/);
        const relH = d.match(/^\\+(\\d+)h$/);
        if (rel) {
          base.dueMode = 'relative_days';
          base.dueN = Number(rel[1]);
          base.dueTime = rel[2] || '';
        } else if (relH) {
          base.dueMode = 'relative_hours';
          base.dueN = Number(relH[1]);
        } else if (d.startsWith('tomorrow')) {
          base.dueMode = 'tomorrow';
          base.dueTime = d.includes('@') ? d.split('@')[1] : '';
        } else if (d.startsWith('next_friday')) {
          base.dueMode = 'next_friday';
          base.dueTime = d.includes('@') ? d.split('@')[1] : '';
        } else if (d.startsWith('next_monday')) {
          base.dueMode = 'next_monday';
          base.dueTime = d.includes('@') ? d.split('@')[1] : '';
        } else {
          base.dueMode = 'custom';
          base.dueCustom = d;
        }
      }
      // Reminders: array of DSL strings
      if (Array.isArray(obj.reminders)) {
        base.reminders = obj.reminders.map(r => {
          if (typeof r !== 'string') return { mode: 'custom', custom: String(r) };
          const md = r.match(/^-(\\d+)d(?:@(cob|\\d{2}:\\d{2}))?$/);
          const mh = r.match(/^-(\\d+)h$/);
          if (md) return { mode: 'relative_days', n: Number(md[1]), time: md[2] || '09:00', custom: '' };
          if (mh) return { mode: 'relative_hours', n: Number(mh[1]), time: '', custom: '' };
          return { mode: 'custom', n: 1, time: '', custom: r };
        });
      }
      return base;
    },
    computedDueDsl() {
      const t = this.task;
      if (t.dueMode === 'none') return '';
      if (t.dueMode === 'custom') return t.dueCustom || '';
      if (t.dueMode === 'relative_days') {
        const base = '+' + (t.dueN || 1) + 'd';
        return t.dueTime ? base + '@' + t.dueTime : base;
      }
      if (t.dueMode === 'relative_hours') {
        return '+' + (t.dueN || 1) + 'h';
      }
      if (t.dueMode === 'tomorrow' || t.dueMode === 'next_friday' || t.dueMode === 'next_monday') {
        return t.dueTime ? t.dueMode + '@' + t.dueTime : t.dueMode;
      }
      return '';
    },
    computedReminderDsls() {
      return (this.task.reminders || []).map(r => {
        if (r.mode === 'custom') return r.custom || '';
        if (r.mode === 'relative_days') {
          const base = '-' + (r.n || 1) + 'd';
          return r.time ? base + '@' + r.time : base;
        }
        if (r.mode === 'relative_hours') {
          return '-' + (r.n || 1) + 'h';
        }
        return '';
      }).filter(Boolean);
    },
    addReminder() {
      this.task.reminders.push({ mode: 'relative_days', n: 1, time: '09:00', custom: '' });
    },
    removeReminder(i) {
      this.task.reminders.splice(i, 1);
    },
    reminderModeChanged(i) {
      const r = this.task.reminders[i];
      if (r.mode === 'relative_days' && !r.time) r.time = '09:00';
    },
    insertToken(inputEl, token) {
      if (!inputEl || !token) return;
      const start = inputEl.selectionStart ?? inputEl.value.length;
      const end = inputEl.selectionEnd ?? inputEl.value.length;
      const v = inputEl.value;
      inputEl.value = v.slice(0, start) + token + v.slice(end);
      // Fire an input event so x-model picks it up.
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      inputEl.focus();
      const pos = start + token.length;
      inputEl.setSelectionRange(pos, pos);
    },
    serialize() {
      const t = this.task;
      const out = { title: t.title || '' };
      out.body = t.body || null;
      if (t.assigneePreset === 'specific') {
        out.assignee = t.assigneeUserId ? 'user:' + t.assigneeUserId : null;
      } else {
        out.assignee = t.assigneePreset;
      }
      const due = this.computedDueDsl();
      out.due_at = due || null;
      out.reminders = this.computedReminderDsls();
      out.link = t.link || null;
      return out;
    },
    loadFromRaw() {
      try {
        const obj = this.rawJson && this.rawJson.trim() ? JSON.parse(this.rawJson) : {};
        this.task = this.deserialize(JSON.stringify(obj));
        this.status = 'Loaded into builder.';
        this.error = false;
        setTimeout(() => { this.status = ''; }, 1500);
      } catch (err) {
        this.status = 'Invalid JSON: ' + err.message;
        this.error = true;
      }
    },
    async save() {
      if (!this.task.title) {
        this.status = 'Title is required';
        this.error = true;
        return;
      }
      this.saving = true;
      this.status = 'Saving...';
      this.error = false;
      try {
        const obj = this.serialize();
        const value = JSON.stringify(obj, null, 2);
        const d = await patchRule('task_json', value);
        if (d.ok) {
          this.status = 'Saved';
          this.rawJson = value;
          setTimeout(() => { this.status = ''; }, 1500);
        } else {
          this.status = 'Error: ' + (d.error || 'save failed');
          this.error = true;
        }
      } catch (err) {
        this.status = 'Network error';
        this.error = true;
      } finally {
        this.saving = false;
      }
    },
    async saveRaw() {
      this.saving = true;
      this.status = 'Saving...';
      this.error = false;
      try {
        const d = await patchRule('task_json', (this.rawJson || '').trim());
        if (d.ok) {
          this.status = 'Saved';
          this.task = this.deserialize(this.rawJson);
          setTimeout(() => { this.status = ''; }, 1500);
        } else {
          this.status = 'Error: ' + (d.error || 'save failed');
          this.error = true;
        }
      } catch (err) {
        this.status = 'Network error';
        this.error = true;
      } finally {
        this.saving = false;
      }
    },
  };
}
`;
}
