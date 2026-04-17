// functions/settings/auto-tasks/[id]/index.js
//
// GET /settings/auto-tasks/:id — rule detail + editor
//
// Renders:
//   - inline-editable name, description, tz (auto-save on blur)
//   - trigger dropdown (inline-save on change)
//   - active toggle (inline-save on change)
//   - JSON editors for conditions_json + task_json with:
//       * monospace textarea
//       * live client-side parse validation (red/green border)
//       * explicit "Save" button (JSON is too fragile for blur-save)
//   - recent fires table (last 10) + fire/skip counts
//   - delete button (confirm)
//
// All inline saves POST to ./patch.js; JSON saves also POST to patch.js
// but with field = "conditions_json" | "task_json" and value = the raw
// stringified JSON body.

import { one, all } from '../../../lib/db.js';
import { layout, htmlResponse, html, escape, raw } from '../../../lib/layout.js';
import { readFlash } from '../../../lib/http.js';
import { hasRole } from '../../../lib/auth.js';
import { TRIGGERS } from '../index.js';

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

  // Pretty-print the JSON blobs for the editor. If the stored value is
  // null/empty/invalid, show an empty textarea so the user starts fresh.
  function prettify(s) {
    if (!s) return '';
    try { return JSON.stringify(JSON.parse(s), null, 2); }
    catch { return s; }
  }
  const conditionsPretty = prettify(rule.conditions_json);
  const taskPretty = prettify(rule.task_json);

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
          <select @change="saveSelect('trigger', $event.target.value)" style="width:100%;">
            ${TRIGGERS.map((t) => html`
              <option value="${escape(t.key)}" ${rule.trigger === t.key ? 'selected' : ''}>
                ${escape(t.label)} (${escape(t.key)})
              </option>
            `)}
          </select>
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
        JSON object keyed by payload path → expected value. Empty = no
        conditions (fire for every event of this trigger type).<br>
        Supports: primitive equality, <code>{"in":[...]}</code>,
        <code>{"neq":value}</code>, <code>{"eq":value}</code>,
        <code>{"exists":true|false}</code>.
      </p>
      <div x-data="jsonEditor('conditions_json', ${escape(JSON.stringify(conditionsPretty))})">
        <textarea class="json-editor" rows="6"
                  x-ref="input"
                  x-model="value"
                  @input.debounce.300ms="validate()"
                  :class="{ 'json-editor--ok': valid === true, 'json-editor--err': valid === false }"
                  placeholder='e.g. {"opportunity.stage":"closed_won"}'></textarea>
        <div style="display:flex; gap:0.5rem; align-items:center; margin-top:0.5rem;">
          <button class="btn primary" type="button" @click="save()" :disabled="saving || valid === false">Save conditions</button>
          <span x-show="status" x-text="status" :style="'color:' + (valid === false ? '#b00' : '#080')"></span>
        </div>
      </div>

      <h2 class="section-h" style="margin-top:1.5rem;">Task template</h2>
      <p class="muted">
        JSON object describing the task to create. Required:
        <code>title</code>. Optional:
        <code>body</code>, <code>assignee</code>
        (<code>trigger.user</code> / <code>opportunity.owner</code> /
        <code>quote.owner</code> / <code>user:&lt;uuid&gt;</code>),
        <code>due_at</code> (<code>+Nd@cob</code>, <code>+Nh</code>,
        <code>tomorrow@09:00</code>, <code>next_friday@cob</code>, ...),
        <code>reminders</code> (array like
        <code>["-1d@09:00","-2h"]</code>), <code>link</code>
        (<code>opportunity</code> / <code>quote</code> / <code>account</code>).
        Substitute payload values with <code>{path.to.field}</code>.
      </p>
      <div x-data="jsonEditor('task_json', ${escape(JSON.stringify(taskPretty))})">
        <textarea class="json-editor" rows="12"
                  x-ref="input"
                  x-model="value"
                  @input.debounce.300ms="validate()"
                  :class="{ 'json-editor--ok': valid === true, 'json-editor--err': valid === false }"
                  placeholder='{"title":"..."}'></textarea>
        <div style="display:flex; gap:0.5rem; align-items:center; margin-top:0.5rem;">
          <button class="btn primary" type="button" @click="save()" :disabled="saving || valid === false">Save task template</button>
          <span x-show="status" x-text="status" :style="'color:' + (valid === false ? '#b00' : '#080')"></span>
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

    <style>${raw(jsonEditorStyles())}</style>
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

function jsonEditorStyles() {
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
    .json-editor--ok  { border-color: #0a0; }
    .json-editor--err { border-color: #c00; }
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

function jsonEditor(field, initial) {
  return {
    field: field,
    value: initial || '',
    valid: null,     // null = untouched, true = parses, false = error
    status: '',
    saving: false,
    init() {
      this.validate();
    },
    validate() {
      const v = (this.value || '').trim();
      if (!v) { this.valid = true; this.status = ''; return; }
      try { JSON.parse(v); this.valid = true; this.status = ''; }
      catch (err) { this.valid = false; this.status = 'JSON error: ' + err.message; }
    },
    async save() {
      if (this.valid === false) return;
      this.saving = true;
      this.status = 'Saving...';
      try {
        const res = await fetch(window.location.pathname + '/patch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            field: this.field,
            // Send empty string for "null" so the server stores NULL.
            value: (this.value || '').trim(),
          }),
        });
        const d = await res.json();
        if (d.ok) {
          this.status = 'Saved';
          setTimeout(() => { this.status = ''; }, 1500);
        } else {
          this.status = 'Error: ' + (d.error || 'save failed');
          this.valid = false;
        }
      } catch (err) {
        this.status = 'Network error';
        this.valid = false;
      } finally {
        this.saving = false;
      }
    },
  };
}
`;
}
