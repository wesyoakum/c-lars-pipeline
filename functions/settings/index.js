// functions/settings/index.js
//
// GET /settings — user Settings page.
//
// Two audiences on one page:
//   * Any authenticated user sees the "Display preferences" section
//     (three per-user toggles) plus a "Reset to defaults" button.
//   * Admins additionally see a "Save current as site-wide defaults"
//     button and an "Admin tools" grid with links like Auto-Task
//     Rules.
//
// The three toggles used to live in a gear-icon popup in the header;
// they were moved here so there's a single obvious place for all user
// preferences. The popup and its Alpine component were removed from
// layout.js in the same change.

import { one } from '../lib/db.js';
import { layout, htmlResponse, html, raw } from '../lib/layout.js';
import { readFlash } from '../lib/http.js';
import { hasRole } from '../lib/auth.js';
import { VALIDITY_DAYS_TYPES, getQuoteValidityDays } from '../lib/quote-term-defaults.js';
import { loadEpsSchedule } from '../lib/eps-schedule.js';
import { QUOTE_TYPE_LABELS } from '../lib/validators.js';
import { settingsSubNav } from '../lib/settings-subnav.js';

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);

  if (!user) {
    // Middleware will have already 401'd in production; belt-and-suspenders.
    return htmlResponse(
      layout('Settings', `<section class="card"><h1>Settings</h1><p>Sign in required.</p></section>`, { env: data?.env, activeNav: '/settings' }),
      { status: 401 }
    );
  }

  const isAdmin = hasRole(user, 'admin');

  // Pull the current user's pref values fresh from the DB so the
  // toggles reflect reality (the middleware's in-memory `user` is
  // accurate but this future-proofs us against drift).
  const prefs = (await one(
    env.DB,
    'SELECT show_alias, group_rollup, active_only FROM users WHERE id = ?',
    [user.id]
  )) || { show_alias: 0, group_rollup: 0, active_only: 0 };

  // Admin-only: per-quote-type validity days for the editor below.
  let validityDays = null;
  let epsSchedule = null;
  if (isAdmin) {
    // Current per-quote-type validity days — used by the Settings editor
    // below. getQuoteValidityDays falls back to 14 when no row exists.
    validityDays = {};
    for (const qt of VALIDITY_DAYS_TYPES) {
      validityDays[qt] = await getQuoteValidityDays(env, qt, 14);
    }
    // Current EPS default payment schedule (migration 0040).
    epsSchedule = await loadEpsSchedule(env);
  }

  const sa = prefs.show_alias ? 1 : 0;
  const gr = prefs.group_rollup ? 1 : 0;
  const ao = prefs.active_only ? 1 : 0;

  const body = html`
    ${settingsSubNav('preferences', isAdmin)}

    <section class="card" x-data="settingsPrefs(${sa}, ${gr}, ${ao}, ${isAdmin ? 'true' : 'false'})">
      <div class="card-header">
        <h1>Preferences</h1>
      </div>

      <h2 style="margin-top:1rem">Display preferences</h2>
      <p class="muted">Control how the app looks for you. These are per-user and save automatically when toggled.</p>

      <div class="settings-prefs-list">
        <div class="settings-pref-row">
          <div class="settings-pref-label">
            <strong>Show aliases</strong>
            <span class="muted">Display the conversational alias instead of the legal account name everywhere — lists, columns, dropdowns, mentions.</span>
          </div>
          <label class="toggle-switch" :class="{ 'toggle-switch--on': showAlias }">
            <input type="checkbox" :checked="showAlias" @change="save('show_alias', $event.target.checked)">
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="settings-pref-row">
          <div class="settings-pref-label">
            <strong>Group accounts</strong>
            <span class="muted">Roll grouped accounts into one row on the Accounts list, and show the group label on opportunity / quote / task lists. Creating a new entity prompts you to pick which member account it's for.</span>
          </div>
          <label class="toggle-switch" :class="{ 'toggle-switch--on': groupRollup }">
            <input type="checkbox" :checked="groupRollup" @change="save('group_rollup', $event.target.checked)">
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="settings-pref-row">
          <div class="settings-pref-label">
            <strong>Show only active</strong>
            <span class="muted">Hide closed / dead / cancelled records across every list and wizard picker. Detail-page links still work directly. Wizard pickers get a per-field "Show inactive" override.</span>
          </div>
          <label class="toggle-switch" :class="{ 'toggle-switch--on': activeOnly }">
            <input type="checkbox" :checked="activeOnly" @change="save('active_only', $event.target.checked)">
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>

      <div class="settings-actions">
        <button type="button" class="btn" :disabled="busy" @click="resetToDefaults()">
          Reset to defaults
        </button>
        ${isAdmin ? html`
          <button type="button" class="btn" :disabled="busy" @click="saveAsDefaults()">
            Save my preferences as site-wide defaults
          </button>
        ` : ''}
      </div>
      ${isAdmin ? html`
        <p class="muted" style="margin-top:0.5rem">
          "Save as defaults" captures your current three toggles <em>and</em>
          your per-table filter / sort / column-visibility choices
          (from every list page you've visited) as the starting point
          for every new user who logs in. Existing users keep their
          own prefs until they click "Reset to defaults".
        </p>
      ` : ''}
    </section>

    ${isAdmin ? html`
      <section class="card" x-data="quoteValidityEditor(${JSON.stringify(validityDays || {})})">
        <h2>Quote expiration defaults</h2>
        <p class="muted">
          How many days from issuance each quote type stays valid.
          Drafts display "today + N" live; the date locks to
          <code>submitted_at + N</code> when the quote is issued.
          Hybrid quotes use the shortest window across their parts.
        </p>
        <table class="meta-table" style="max-width:24rem">
          <thead>
            <tr><th style="text-align:left">Quote type</th><th style="text-align:right">Days</th></tr>
          </thead>
          <tbody>
            ${VALIDITY_DAYS_TYPES.map(qt => html`
              <tr>
                <td>${QUOTE_TYPE_LABELS[qt] || qt}</td>
                <td style="text-align:right">
                  <input type="number" min="1" max="3650" step="1"
                         x-model.number="days['${qt}']"
                         @change="save('${qt}', $event.target.value)"
                         :disabled="busy['${qt}']"
                         style="width:5rem;text-align:right">
                </td>
              </tr>
            `)}
          </tbody>
        </table>
        <p class="muted" style="margin-top:0.5rem;font-size:0.85em">
          Changes save automatically when you leave the field.
        </p>
      </section>

      <section class="card" x-data="epsScheduleEditor(${JSON.stringify(epsSchedule || { rows: [] })})">
        <h2>EPS default payment schedule</h2>
        <p class="muted">
          Milestone rows that populate the "Default EPS Terms" textarea
          on new EPS quotes. Percentages must sum to exactly 100 —
          they're applied to the quote total. Use <code>{weeks}</code>
          in the label to substitute a delivery-week value, computed
          as <code>floor(num &times; delivery_weeks / den)</code>.
        </p>
        <table class="meta-table" style="width:100%">
          <thead>
            <tr>
              <th style="text-align:right;width:5rem">%</th>
              <th style="text-align:left">Label</th>
              <th style="text-align:center;width:8rem">ARO num</th>
              <th style="text-align:center;width:8rem">ARO den</th>
              <th style="width:3rem"></th>
            </tr>
          </thead>
          <tbody>
            <template x-for="(row, i) in rows" :key="i">
              <tr>
                <td style="text-align:right">
                  <input type="number" min="0" max="100" step="0.01"
                         x-model.number="row.percent"
                         style="width:4.5rem;text-align:right">
                </td>
                <td>
                  <input type="text" x-model="row.label"
                         placeholder="Due upon …"
                         style="width:100%">
                </td>
                <td style="text-align:center">
                  <input type="number" min="1" step="1"
                         x-model="row.weeks_num"
                         placeholder="—"
                         style="width:5rem;text-align:right">
                </td>
                <td style="text-align:center">
                  <input type="number" min="1" step="1"
                         x-model="row.weeks_den"
                         placeholder="—"
                         style="width:5rem;text-align:right">
                </td>
                <td style="text-align:center">
                  <button type="button" class="btn btn-xs" @click="removeRow(i)" title="Remove row">&times;</button>
                </td>
              </tr>
            </template>
            <tr>
              <td style="text-align:right"><strong x-text="totalPct"></strong></td>
              <td class="muted" x-text="totalLabel"></td>
              <td colspan="3"></td>
            </tr>
          </tbody>
        </table>
        <div class="settings-actions" style="margin-top:0.75rem">
          <button type="button" class="btn" @click="addRow()">+ Add row</button>
          <button type="button" class="btn primary" :disabled="busy || !isValid" @click="save()" x-text="saveLabel"></button>
          <button type="button" class="btn" :disabled="busy" @click="resetToDefault()">Reset to site default</button>
        </div>
        <p class="muted" style="margin-top:0.5rem;font-size:0.85em">
          Example rendered label with <code>delivery_weeks = 9</code>:
          <code x-text="preview"></code>
        </p>
      </section>

    ` : ''}

    <script>${raw(SETTINGS_PREFS_SCRIPT)}</script>
  `;

  return htmlResponse(
    layout('Settings', body, {
      user,
      env: data?.env,
      activeNav: '/settings',
      flash: readFlash(url),
      breadcrumbs: [{ label: 'Settings' }],
    })
  );
}

// Alpine component backing the three toggles + the two action buttons.
// PATCHes /user/prefs per-toggle (same endpoint the old gear popup used)
// and POSTs to /user/prefs-reset or /settings/save-defaults on button
// clicks, then reloads the page so server-rendered lists pick up the
// new values immediately.
const SETTINGS_PREFS_SCRIPT = `
document.addEventListener('alpine:init', function () {
  Alpine.data('settingsPrefs', function (showAlias, groupRollup, activeOnly, isAdmin) {
    return {
      showAlias: !!showAlias,
      groupRollup: !!groupRollup,
      activeOnly: !!activeOnly,
      isAdmin: !!isAdmin,
      busy: false,
      save: function (key, next) {
        var self = this;
        var prop = key === 'show_alias' ? 'showAlias'
                 : key === 'group_rollup' ? 'groupRollup'
                 : key === 'active_only'  ? 'activeOnly'
                 : null;
        if (!prop) return;
        var prev = self[prop];
        self[prop] = !!next;
        self.busy = true;
        var body = {};
        body[key] = next ? 1 : 0;
        fetch('/user/prefs', {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        }).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          window.location.reload();
        }).catch(function (err) {
          self[prop] = prev;
          self.busy = false;
          alert('Could not save preference: ' + (err && err.message ? err.message : 'unknown error'));
        });
      },
      resetToDefaults: function () {
        if (!confirm('Reset your display preferences AND per-table filter / sort / column choices to the site-wide defaults?')) return;
        var self = this;
        self.busy = true;
        fetch('/user/prefs-reset', {
          method: 'POST',
          credentials: 'same-origin',
        }).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json().catch(function () { return {}; });
        }).then(function (body) {
          // Blow away every list-table's localStorage entry, then
          // re-seed from the site defaults the server just handed
          // back. Prefixed scan so we only touch pipeline.* keys (not
          // unrelated app state).
          try {
            var toRemove = [];
            for (var i = 0; i < localStorage.length; i++) {
              var k = localStorage.key(i);
              if (k && k.indexOf('pipeline.') === 0) toRemove.push(k);
            }
            toRemove.forEach(function (k) { localStorage.removeItem(k); });
            var defaults = body && body.list_table_defaults;
            if (defaults && typeof defaults === 'object') {
              Object.keys(defaults).forEach(function (k) {
                try { localStorage.setItem(k, JSON.stringify(defaults[k])); } catch (_) {}
              });
            }
          } catch (_) {}
          window.location.reload();
        }).catch(function (err) {
          self.busy = false;
          alert('Could not reset: ' + (err && err.message ? err.message : 'unknown error'));
        });
      },
      saveAsDefaults: function () {
        if (!confirm('Save your current preferences AND per-table filter / sort / column choices as the site-wide defaults for all new users?')) return;
        var self = this;
        self.busy = true;
        // Collect every list-table payload from localStorage (any key
        // that starts with "pipeline." and parses as an object). The
        // server validates the shape; we send whatever's there.
        var listDefaults = {};
        try {
          for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            if (!k || k.indexOf('pipeline.') !== 0) continue;
            var raw = localStorage.getItem(k);
            if (!raw) continue;
            try {
              var parsed = JSON.parse(raw);
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                listDefaults[k] = parsed;
              }
            } catch (_) {}
          }
        } catch (_) {}
        fetch('/settings/save-defaults', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ list_table_defaults: listDefaults }),
        }).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          self.busy = false;
          var n = Object.keys(listDefaults).length;
          alert('Saved as site-wide defaults (' + n + ' list table' + (n === 1 ? '' : 's') + ').');
        }).catch(function (err) {
          self.busy = false;
          alert('Could not save: ' + (err && err.message ? err.message : 'unknown error'));
        });
      },
    };
  });

  // EPS default payment-schedule editor. A single blob stored on
  // site_prefs.eps_schedule (migration 0040). Validates client-side
  // (percentages must sum to 100) so the Save button is disabled
  // until the total is correct; the server validates again and is
  // authoritative.
  Alpine.data('epsScheduleEditor', function (initial) {
    function cloneRows(src) {
      return (src.rows || []).map(function (r) {
        return {
          percent: r.percent == null ? '' : Number(r.percent),
          label: r.label || '',
          weeks_num: r.weeks_num == null ? '' : String(r.weeks_num),
          weeks_den: r.weeks_den == null ? '' : String(r.weeks_den),
        };
      });
    }
    return {
      rows: cloneRows(initial),
      busy: false,
      saveLabel: 'Save EPS schedule',
      get totalPct() {
        var sum = 0;
        this.rows.forEach(function (r) {
          var n = Number(r.percent);
          if (Number.isFinite(n)) sum += n;
        });
        return Math.round(sum * 100) / 100;
      },
      get totalLabel() {
        var t = this.totalPct;
        if (Math.abs(t - 100) <= 0.01) return 'Total: 100% \u2713';
        return 'Total: ' + t + '% (must equal 100)';
      },
      get isValid() {
        if (this.rows.length === 0) return false;
        if (Math.abs(this.totalPct - 100) > 0.01) return false;
        for (var i = 0; i < this.rows.length; i++) {
          var r = this.rows[i];
          var p = Number(r.percent);
          if (!Number.isFinite(p) || p <= 0 || p > 100) return false;
          if (!r.label || !String(r.label).trim()) return false;
          var hasNum = r.weeks_num !== '' && r.weeks_num != null;
          var hasDen = r.weeks_den !== '' && r.weeks_den != null;
          if (hasNum !== hasDen) return false;
          if (hasNum) {
            var n = parseInt(r.weeks_num, 10);
            var d = parseInt(r.weeks_den, 10);
            if (!Number.isInteger(n) || n <= 0) return false;
            if (!Number.isInteger(d) || d <= 0) return false;
          }
        }
        return true;
      },
      get preview() {
        // Render with delivery_weeks = 9 for a quick sanity check.
        var W = 9;
        var lines = [];
        this.rows.forEach(function (r) {
          var label = String(r.label || '');
          var hasNum = r.weeks_num !== '' && r.weeks_num != null;
          if (hasNum) {
            var n = parseInt(r.weeks_num, 10);
            var d = parseInt(r.weeks_den, 10);
            if (Number.isInteger(n) && Number.isInteger(d) && d > 0) {
              var w = Math.floor((n * W) / d);
              label = label.replace(/\{weeks\}/g, String(w));
            }
          }
          lines.push(r.percent + '% ' + label);
        });
        return lines.join(' \u2022 ');
      },
      addRow: function () {
        this.rows.push({ percent: 0, label: '', weeks_num: '', weeks_den: '' });
      },
      removeRow: function (i) {
        this.rows.splice(i, 1);
      },
      save: function () {
        var self = this;
        if (!self.isValid) return;
        self.busy = true;
        self.saveLabel = 'Saving\u2026';
        var payload = {
          rows: self.rows.map(function (r) {
            var out = { percent: Number(r.percent), label: String(r.label).trim() };
            if (r.weeks_num !== '' && r.weeks_num != null) {
              out.weeks_num = parseInt(r.weeks_num, 10);
              out.weeks_den = parseInt(r.weeks_den, 10);
            }
            return out;
          }),
        };
        fetch('/settings/eps-schedule', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).then(function (r) {
          if (!r.ok) return r.json().then(function (d) { throw new Error(d && d.error || ('HTTP ' + r.status)); });
          return r.json();
        }).then(function () {
          self.saveLabel = 'Saved \u2713';
          self.busy = false;
          setTimeout(function () { self.saveLabel = 'Save EPS schedule'; }, 1500);
        }).catch(function (err) {
          self.busy = false;
          self.saveLabel = 'Save EPS schedule';
          alert('Could not save: ' + (err && err.message ? err.message : 'unknown error'));
        });
      },
      resetToDefault: function () {
        if (!confirm('Reset the EPS schedule to the built-in default (25/25/25/15/10 with ARO 1/3 and 2/3)? This does not save until you click "Save EPS schedule".')) return;
        this.rows = [
          { percent: 25, label: 'Due upon receipt of purchase order', weeks_num: '', weeks_den: '' },
          { percent: 25, label: 'Due {weeks} weeks ARO', weeks_num: '1', weeks_den: '3' },
          { percent: 25, label: 'Due {weeks} weeks ARO', weeks_num: '2', weeks_den: '3' },
          { percent: 15, label: 'Due upon completion of FAT', weeks_num: '', weeks_den: '' },
          { percent: 10, label: 'Due upon delivery of final documentation', weeks_num: '', weeks_den: '' },
        ];
      },
    };
  });

  // Quote validity-days editor. One number input per quote_type; each
  // @change POSTs to /settings/quote-validity-days which upserts the
  // (type, 'validity_days') row in quote_term_defaults. Busy flag is
  // per-type so two adjacent inputs can't trample each other.
  Alpine.data('quoteValidityEditor', function (initial) {
    var days = {};
    var busy = {};
    Object.keys(initial || {}).forEach(function (k) {
      days[k] = Number(initial[k]) || 14;
      busy[k] = false;
    });
    return {
      days: days,
      busy: busy,
      save: function (quoteType, rawValue) {
        var self = this;
        var n = parseInt(rawValue, 10);
        if (!Number.isFinite(n) || n <= 0) {
          alert('Days must be a positive whole number.');
          return;
        }
        self.busy[quoteType] = true;
        fetch('/settings/quote-validity-days', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ quote_type: quoteType, days: n }),
        }).then(function (r) {
          self.busy[quoteType] = false;
          if (!r.ok) throw new Error('HTTP ' + r.status);
          self.days[quoteType] = n;
        }).catch(function (err) {
          self.busy[quoteType] = false;
          alert('Could not save: ' + (err && err.message ? err.message : 'unknown error'));
        });
      },
    };
  });
});
`;
