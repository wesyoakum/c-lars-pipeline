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
import { QUOTE_TYPE_LABELS } from '../lib/validators.js';

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

  // Admin counts for the Auto-Task Rules card.
  let ruleCount = null;
  let activeCount = null;
  let userCount = null;
  let activeUserCount = null;
  let validityDays = null;
  if (isAdmin) {
    ruleCount = await one(env.DB, 'SELECT COUNT(*) AS n FROM task_rules');
    activeCount = await one(env.DB, 'SELECT COUNT(*) AS n FROM task_rules WHERE active = 1');
    userCount = await one(env.DB, 'SELECT COUNT(*) AS n FROM users');
    activeUserCount = await one(env.DB, 'SELECT COUNT(*) AS n FROM users WHERE active = 1');
    // Current per-quote-type validity days — used by the Settings editor
    // below. getQuoteValidityDays falls back to 14 when no row exists.
    validityDays = {};
    for (const qt of VALIDITY_DAYS_TYPES) {
      validityDays[qt] = await getQuoteValidityDays(env, qt, 14);
    }
  }

  const sa = prefs.show_alias ? 1 : 0;
  const gr = prefs.group_rollup ? 1 : 0;
  const ao = prefs.active_only ? 1 : 0;

  const body = html`
    <section class="card" x-data="settingsPrefs(${sa}, ${gr}, ${ao}, ${isAdmin ? 'true' : 'false'})">
      <div class="card-header">
        <h1>Settings</h1>
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
          "Save as defaults" captures your current three toggles as the
          starting point for every new user who logs in. Existing users
          keep their own prefs until they click "Reset to defaults".
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

      <section class="card">
        <h2>Admin tools</h2>
        <p class="muted">Configuration that affects every user.</p>
        <div class="library-grid">
          <a class="library-card" href="/settings/auto-tasks">
            <h3>Auto-Task Rules</h3>
            <p class="muted">Rules that automatically create tasks in response to events (quote issued, opportunity stage changed, PDF errors, ...).</p>
            <p class="library-count">
              <strong>${activeCount?.n ?? 0}</strong> active
              ${ruleCount?.n !== activeCount?.n
                ? html` / ${ruleCount?.n ?? 0} total`
                : ''}
            </p>
          </a>
          <a class="library-card" href="/settings/users">
            <h3>Users</h3>
            <p class="muted">Everyone who has signed in. Adjust role or mark inactive.</p>
            <p class="library-count">
              <strong>${activeUserCount?.n ?? 0}</strong> active
              ${userCount?.n !== activeUserCount?.n
                ? html` / ${userCount?.n ?? 0} total`
                : ''}
            </p>
          </a>
        </div>
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
        if (!confirm('Reset your display preferences to the site-wide defaults?')) return;
        var self = this;
        self.busy = true;
        fetch('/user/prefs-reset', {
          method: 'POST',
          credentials: 'same-origin',
        }).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          window.location.reload();
        }).catch(function (err) {
          self.busy = false;
          alert('Could not reset: ' + (err && err.message ? err.message : 'unknown error'));
        });
      },
      saveAsDefaults: function () {
        if (!confirm('Save your current preferences as the site-wide defaults for all new users?')) return;
        var self = this;
        self.busy = true;
        fetch('/settings/save-defaults', {
          method: 'POST',
          credentials: 'same-origin',
        }).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          self.busy = false;
          alert('Saved as site-wide defaults.');
        }).catch(function (err) {
          self.busy = false;
          alert('Could not save: ' + (err && err.message ? err.message : 'unknown error'));
        });
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
