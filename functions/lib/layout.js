// functions/lib/layout.js
//
// Small server-side HTML layout helper. PMS is rendered as plain HTML
// with HTMX for interactivity and Alpine.js for small local state —
// no build step, no framework, no hydration. Every page is a function
// that returns a string, wrapped in `layout(title, body, { user })`.
//
// Usage:
//   import { layout, html, escape } from '../lib/layout.js';
//   return new Response(
//     layout('Dashboard', `<h1>Welcome ${escape(user.display_name)}</h1>`, { user }),
//     { headers: { 'content-type': 'text/html; charset=utf-8' } }
//   );

/**
 * Escape a string for safe interpolation into HTML content or
 * attribute values. Handles null/undefined.
 *
 * Returns a raw-marked object (not a plain string) so the html tagged
 * template's renderValue() recognizes it as already-escaped and does
 * NOT escape it a second time. The toString() shim keeps it usable
 * inside plain template literals (`${escape(x)}` in a regular backtick
 * string) and any other place that coerces to string.
 *
 * Without this, JSON serialized into a data-* attribute via
 *   data-foo="${escape(JSON.stringify(obj))}"
 * gets the `&` in `&quot;` re-escaped to `&amp;quot;`, and the browser
 * decodes that back to literal text `&quot;` — which is not valid JSON.
 */
export function escape(value) {
  if (value === null || value === undefined) {
    return { __raw: '', toString() { return ''; } };
  }
  const escaped = String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  return { __raw: escaped, toString() { return escaped; } };
}

/**
 * Tagged template literal for HTML. Auto-escapes interpolated values
 * unless they are wrapped in raw() or are arrays (which are joined
 * with no separator and interpolated recursively).
 *
 *   html`<p>Hello ${user.name}</p>`                   // escapes user.name
 *   html`<div>${raw(someHtmlString)}</div>`           // injects literally
 *   html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`
 */
export function html(strings, ...values) {
  let out = '';
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) {
      out += renderValue(values[i]);
    }
  }
  // Return a raw-marked object (not a plain string) so that nested
  // interpolations like  html`<ul>${html`<li>x</li>`}</ul>`  don't get
  // their inner HTML escaped by the outer template's renderValue(). The
  // toString() shim keeps plain template-literal usage working — e.g.
  // layout() interpolates `${body}` into a regular backtick string.
  return { __raw: out, toString() { return out; } };
}

/**
 * Mark a string as raw HTML — it will not be escaped when interpolated
 * via the `html` tagged template.
 */
export function raw(value) {
  const s = String(value ?? '');
  return { __raw: s, toString() { return s; } };
}

function renderValue(value) {
  if (value === null || value === undefined || value === false) return '';
  if (value && typeof value === 'object' && '__raw' in value) return value.__raw;
  if (Array.isArray(value)) return value.map(renderValue).join('');
  return escape(value);
}

import { VERSION } from './version.js';

// T4.2 Phase 1 — in-app notifications.
//
// Injected into every authenticated page. Registers an Alpine store
// named "notifications" that polls /notifications/unread every 30 seconds,
// updates the bell-icon badge count, and pushes new (unseen) notifications
// into a toast stack. The first poll after page load is silent — we
// populate the badge count but don't toast existing unreads, because
// spamming old unreads every page load would be annoying. Only truly
// NEW notifications (arriving while the page is open) become toasts.
//
// Deliberately no backticks or `${}` in this script so it can be dropped
// into a plain template literal in layout() without interpolation conflicts.
//
// Store method is named `start()` (not `init()`) to avoid Alpine v3's
// auto-invocation of store.init() — we want explicit control so the
// polling loop starts exactly once.
const NOTIFICATION_STORE_SCRIPT = (
  "document.addEventListener('alpine:init', function () {\n" +
  "  Alpine.store('notifications', {\n" +
  "    count: 0,\n" +
  "    toasts: [],\n" +
  "    seenIds: Object.create(null),\n" +
  "    primed: false,\n" +
  "    pollHandle: null,\n" +
  "    pollMs: 30000,\n" +
  "    start: function () {\n" +
  "      if (this.pollHandle) return;\n" +
  "      var self = this;\n" +
  "      self.poll();\n" +
  "      self.pollHandle = setInterval(function () { self.poll(); }, self.pollMs);\n" +
  "    },\n" +
  "    poll: function () {\n" +
  "      var self = this;\n" +
  "      fetch('/notifications/unread', { credentials: 'same-origin', headers: { 'accept': 'application/json' } })\n" +
  "        .then(function (res) { return res.ok ? res.json() : null; })\n" +
  "        .then(function (data) {\n" +
  "          if (!data || !Array.isArray(data.unread)) return;\n" +
  "          self.count = data.unread.length;\n" +
  "          if (!self.primed) {\n" +
  "            for (var i = 0; i < data.unread.length; i++) self.seenIds[data.unread[i].id] = true;\n" +
  "            self.primed = true;\n" +
  "            return;\n" +
  "          }\n" +
  "          for (var j = 0; j < data.unread.length; j++) {\n" +
  "            var n = data.unread[j];\n" +
  "            if (!self.seenIds[n.id]) {\n" +
  "              self.seenIds[n.id] = true;\n" +
  "              self.toasts.push(n);\n" +
  "              (function (notification) {\n" +
  "                setTimeout(function () { self.dismissToast(notification); }, 8000);\n" +
  "              })(n);\n" +
  "            }\n" +
  "          }\n" +
  "        })\n" +
  "        .catch(function () { /* network error, ignore */ });\n" +
  "    },\n" +
  "    dismissToast: function (n) {\n" +
  "      if (!n) return;\n" +
  "      for (var i = 0; i < this.toasts.length; i++) {\n" +
  "        if (this.toasts[i].id === n.id) { this.toasts.splice(i, 1); return; }\n" +
  "      }\n" +
  "    },\n" +
  "    clickToast: function (n) {\n" +
  "      if (!n) return;\n" +
  "      var self = this;\n" +
  "      var target = n.link_url;\n" +
  "      fetch('/notifications/' + encodeURIComponent(n.id) + '/read', {\n" +
  "        method: 'POST',\n" +
  "        credentials: 'same-origin',\n" +
  "        headers: { 'accept': 'application/json' }\n" +
  "      }).catch(function () { /* ignore */ });\n" +
  "      self.dismissToast(n);\n" +
  "      self.count = Math.max(0, self.count - 1);\n" +
  "      if (target) window.location.href = target;\n" +
  "    }\n" +
  "  });\n" +
  "  Alpine.store('notifications').start();\n" +
  "});\n"
);

// Global task modal (T+) — Alpine store + helper.
//
// Lives in every authenticated page so any button anywhere can
// trigger it. Callers open the modal by dispatching a window event
// or calling window.PMS.openTaskModal():
//
//   <button onclick="window.PMS.openTaskModal({ opportunity_id: '...' })">+ Task</button>
//
// or via a custom event:
//
//   window.dispatchEvent(new CustomEvent('pms:open-task-modal', { detail: { opportunity_id: '...' } }))
//
// Prefill shape (all optional):
//   { opportunity_id, quote_id, account_id, link_label, reload_on_success }
//
// If link_label is provided, the picker collapses into a pinned
// "Linked to: <label>" row so the user doesn't have to re-select.
//
// Picker data (users, open opps, recent quotes, accounts) is fetched
// lazily the first time the modal opens on a page, from
// /activities/picker-data.
//
// Deliberately uses string concatenation (no template literals /
// backticks) so it can be dropped into layout()'s plain-template-
// literal shell without escaping issues.
const TASK_MODAL_SCRIPT = (
  "document.addEventListener('alpine:init', function () {\n" +
  "  Alpine.store('taskModal', {\n" +
  "    open: false,\n" +
  "    loading: false,\n" +
  "    submitting: false,\n" +
  "    pickerLoaded: false,\n" +
  "    users: [],\n" +
  "    opportunities: [],\n" +
  "    quotes: [],\n" +
  "    accounts: [],\n" +
  "    currentUserId: null,\n" +
  "    prefillLabel: '',\n" +
  "    prefillLocked: false,\n" +
  "    reloadOnSuccess: true,\n" +
  "    error: null,\n" +
  "    form: {\n" +
  "      body: '',\n" +
  "      assigned_user_id: '',\n" +
  "      due_at: '',\n" +
  "      remind_at: '',\n" +
  "      link_type: 'none',\n" +
  "      opportunity_id: '',\n" +
  "      quote_id: '',\n" +
  "      account_id: ''\n" +
  "    },\n" +
  "    openModal: function (prefill) {\n" +
  "      prefill = prefill || {};\n" +
  "      this.error = null;\n" +
  "      this.reloadOnSuccess = prefill.reload_on_success !== false;\n" +
  "      this.form = {\n" +
  "        body: '',\n" +
  "        assigned_user_id: this.currentUserId || '',\n" +
  "        due_at: '',\n" +
  "        remind_at: '',\n" +
  "        link_type: 'none',\n" +
  "        opportunity_id: '',\n" +
  "        quote_id: '',\n" +
  "        account_id: ''\n" +
  "      };\n" +
  "      this.prefillLabel = prefill.link_label || '';\n" +
  "      this.prefillLocked = false;\n" +
  "      if (prefill.opportunity_id) {\n" +
  "        this.form.link_type = 'opportunity';\n" +
  "        this.form.opportunity_id = prefill.opportunity_id;\n" +
  "        this.prefillLocked = !!prefill.link_label;\n" +
  "      } else if (prefill.quote_id) {\n" +
  "        this.form.link_type = 'quote';\n" +
  "        this.form.quote_id = prefill.quote_id;\n" +
  "        this.prefillLocked = !!prefill.link_label;\n" +
  "      } else if (prefill.account_id) {\n" +
  "        this.form.link_type = 'account';\n" +
  "        this.form.account_id = prefill.account_id;\n" +
  "        this.prefillLocked = !!prefill.link_label;\n" +
  "      }\n" +
  "      this.open = true;\n" +
  "      if (!this.pickerLoaded) this.loadPickerData();\n" +
  "      setTimeout(function () {\n" +
  "        var ta = document.getElementById('task-modal-body-input');\n" +
  "        if (ta) ta.focus();\n" +
  "      }, 60);\n" +
  "    },\n" +
  "    closeModal: function () {\n" +
  "      this.open = false;\n" +
  "      this.error = null;\n" +
  "    },\n" +
  "    loadPickerData: function () {\n" +
  "      var self = this;\n" +
  "      self.loading = true;\n" +
  "      fetch('/activities/picker-data', { credentials: 'same-origin', headers: { 'accept': 'application/json' } })\n" +
  "        .then(function (res) { return res.ok ? res.json() : null; })\n" +
  "        .then(function (data) {\n" +
  "          self.loading = false;\n" +
  "          if (!data) { self.error = 'Could not load picker data.'; return; }\n" +
  "          self.users = data.users || [];\n" +
  "          self.opportunities = data.opportunities || [];\n" +
  "          self.quotes = data.quotes || [];\n" +
  "          self.accounts = data.accounts || [];\n" +
  "          self.currentUserId = data.current_user_id || null;\n" +
  "          if (!self.form.assigned_user_id && self.currentUserId) {\n" +
  "            self.form.assigned_user_id = self.currentUserId;\n" +
  "          }\n" +
  "          self.pickerLoaded = true;\n" +
  "        })\n" +
  "        .catch(function () {\n" +
  "          self.loading = false;\n" +
  "          self.error = 'Could not load picker data.';\n" +
  "        });\n" +
  "    },\n" +
  "    submit: function () {\n" +
  "      var self = this;\n" +
  "      if (self.submitting) return;\n" +
  "      var bodyText = (self.form.body || '').trim();\n" +
  "      if (!bodyText) { self.error = 'Please enter task details.'; return; }\n" +
  "      self.submitting = true;\n" +
  "      self.error = null;\n" +
  "      var fd = new FormData();\n" +
  "      fd.append('body', bodyText);\n" +
  "      if (self.form.assigned_user_id) fd.append('assigned_user_id', self.form.assigned_user_id);\n" +
  "      if (self.form.due_at) fd.append('due_at', self.form.due_at);\n" +
  "      if (self.form.remind_at) fd.append('remind_at', self.form.remind_at);\n" +
  "      if (self.form.link_type === 'opportunity' && self.form.opportunity_id) {\n" +
  "        fd.append('opportunity_id', self.form.opportunity_id);\n" +
  "      } else if (self.form.link_type === 'quote' && self.form.quote_id) {\n" +
  "        fd.append('quote_id', self.form.quote_id);\n" +
  "      } else if (self.form.link_type === 'account' && self.form.account_id) {\n" +
  "        fd.append('account_id', self.form.account_id);\n" +
  "      }\n" +
  "      fd.append('source', 'modal');\n" +
  "      fetch('/activities', {\n" +
  "        method: 'POST',\n" +
  "        credentials: 'same-origin',\n" +
  "        body: fd,\n" +
  "        headers: { 'x-requested-with': 'XMLHttpRequest', 'accept': 'application/json' }\n" +
  "      })\n" +
  "        .then(function (res) {\n" +
  "          return res.json().then(function (data) { return { ok: res.ok, data: data }; });\n" +
  "        })\n" +
  "        .then(function (result) {\n" +
  "          self.submitting = false;\n" +
  "          if (!result.ok || !result.data || !result.data.ok) {\n" +
  "            self.error = (result.data && result.data.error) || 'Could not create task.';\n" +
  "            return;\n" +
  "          }\n" +
  "          self.closeModal();\n" +
  "          if (self.reloadOnSuccess) window.location.reload();\n" +
  "        })\n" +
  "        .catch(function () {\n" +
  "          self.submitting = false;\n" +
  "          self.error = 'Could not create task.';\n" +
  "        });\n" +
  "    }\n" +
  "  });\n" +
  "  window.addEventListener('pms:open-task-modal', function (e) {\n" +
  "    Alpine.store('taskModal').openModal((e && e.detail) || {});\n" +
  "  });\n" +
  "  window.PMS = window.PMS || {};\n" +
  "  window.PMS.openTaskModal = function (prefill) {\n" +
  "    Alpine.store('taskModal').openModal(prefill || {});\n" +
  "  };\n" +
  "});\n"
);

// Task modal markup. Rendered once per authenticated page, right
// before the notification toast stack. Uses x-show/x-cloak so it
// stays invisible until the store flips open=true.
const TASK_MODAL_MARKUP = (
  '<div class="task-modal-overlay" x-data x-show="$store.taskModal.open" x-cloak ' +
  '@keydown.escape.window="$store.taskModal.closeModal()" ' +
  '@click.self="$store.taskModal.closeModal()" style="display:none">' +
  '<div class="task-modal" @click.stop>' +
  '<div class="task-modal-header">' +
  '<h3>New task</h3>' +
  '<button type="button" class="task-modal-close" @click="$store.taskModal.closeModal()" aria-label="Close">&times;</button>' +
  '</div>' +
  '<form @submit.prevent="$store.taskModal.submit()" class="task-modal-body">' +
  '<div class="field">' +
  '<label class="field-label" for="task-modal-body-input">Details *</label>' +
  '<textarea id="task-modal-body-input" x-model="$store.taskModal.form.body" rows="3" ' +
  'placeholder="What needs to be done?" required></textarea>' +
  '</div>' +
  '<div class="field-grid">' +
  '<div class="field">' +
  '<label class="field-label">Assigned to</label>' +
  '<select x-model="$store.taskModal.form.assigned_user_id">' +
  '<template x-for="u in $store.taskModal.users" :key="u.id">' +
  '<option :value="u.id" x-text="u.display_name || u.email"></option>' +
  '</template>' +
  '</select>' +
  '</div>' +
  '<div class="field">' +
  '<label class="field-label">Due</label>' +
  '<input type="datetime-local" x-model="$store.taskModal.form.due_at">' +
  '</div>' +
  '</div>' +
  '<div class="field">' +
  '<label class="field-label">Reminder</label>' +
  '<input type="datetime-local" x-model="$store.taskModal.form.remind_at">' +
  '</div>' +
  '<div class="field" x-show="$store.taskModal.prefillLocked">' +
  '<label class="field-label">Linked to</label>' +
  '<div class="task-modal-link-pinned"><strong x-text="$store.taskModal.prefillLabel"></strong></div>' +
  '</div>' +
  '<div class="field" x-show="!$store.taskModal.prefillLocked">' +
  '<label class="field-label">Link to</label>' +
  '<div class="task-modal-link-options">' +
  '<label><input type="radio" x-model="$store.taskModal.form.link_type" value="none"> None</label>' +
  '<label><input type="radio" x-model="$store.taskModal.form.link_type" value="opportunity"> Opportunity</label>' +
  '<label><input type="radio" x-model="$store.taskModal.form.link_type" value="quote"> Quote</label>' +
  '<label><input type="radio" x-model="$store.taskModal.form.link_type" value="account"> Account</label>' +
  '</div>' +
  '<select x-show="$store.taskModal.form.link_type === \'opportunity\'" ' +
  'x-model="$store.taskModal.form.opportunity_id" style="margin-top:0.5rem">' +
  '<option value="">\u2014 select opportunity \u2014</option>' +
  '<template x-for="o in $store.taskModal.opportunities" :key="o.id">' +
  '<option :value="o.id" x-text="o.number + \' \u2014 \' + (o.title || \'\')"></option>' +
  '</template>' +
  '</select>' +
  '<select x-show="$store.taskModal.form.link_type === \'quote\'" ' +
  'x-model="$store.taskModal.form.quote_id" style="margin-top:0.5rem">' +
  '<option value="">\u2014 select quote \u2014</option>' +
  '<template x-for="q in $store.taskModal.quotes" :key="q.id">' +
  '<option :value="q.id" x-text="q.number + \' \u2014 \' + (q.title || \'\')"></option>' +
  '</template>' +
  '</select>' +
  '<select x-show="$store.taskModal.form.link_type === \'account\'" ' +
  'x-model="$store.taskModal.form.account_id" style="margin-top:0.5rem">' +
  '<option value="">\u2014 select account \u2014</option>' +
  '<template x-for="a in $store.taskModal.accounts" :key="a.id">' +
  '<option :value="a.id" x-text="a.alias ? (a.name + \' (\' + a.alias + \')\') : a.name"></option>' +
  '</template>' +
  '</select>' +
  '</div>' +
  '<div class="task-modal-error" x-show="$store.taskModal.error" x-text="$store.taskModal.error"></div>' +
  '<div class="task-modal-footer">' +
  '<button type="button" class="btn" @click="$store.taskModal.closeModal()" ' +
  ':disabled="$store.taskModal.submitting">Cancel</button>' +
  '<button type="submit" class="btn primary" :disabled="$store.taskModal.submitting">' +
  '<span x-show="!$store.taskModal.submitting">Create task</span>' +
  '<span x-show="$store.taskModal.submitting">Saving\u2026</span>' +
  '</button>' +
  '</div>' +
  '</form>' +
  '</div>' +
  '</div>'
);

/**
 * Full-page HTML shell: includes nav, user badge, and slot for body.
 * Vendored HTMX + Alpine from /js so Access + CSP don't fight CDN cross-origin.
 *
 * opts.breadcrumbs — optional array of { label, href? } for the breadcrumb trail.
 */
export function layout(title, body, opts = {}) {
  const { user, flash, activeNav, breadcrumbs } = opts;
  const pageTitle = title ? `${escape(title)} — C-LARS PMS` : 'C-LARS PMS';
  const versionTag = VERSION ? `v${escape(VERSION)}` : '';

  const breadcrumbHtml = breadcrumbs && breadcrumbs.length
    ? `<nav class="breadcrumbs" aria-label="breadcrumb">${breadcrumbs.map((b, i) => {
        const sep = i > 0 ? '<span class="bc-sep">/</span>' : '';
        return b.href
          ? `${sep}<a href="${escape(b.href)}">${escape(b.label)}</a>`
          : `${sep}<span class="bc-current">${escape(b.label)}</span>`;
      }).join('')}</nav>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${pageTitle}</title>
  <link rel="icon" type="image/svg+xml" href="/img/logo.svg">
  <link rel="icon" type="image/png" sizes="120x120" href="/img/logo-120.png">
  <link rel="stylesheet" href="/css/pms.css">
  <script defer src="/js/htmx.min.js"></script>
  <script defer src="/js/alpine.min.js"></script>
  <script defer src="/js/live-calc.js"></script>
  <script defer src="/js/account-picker.js"></script>
  ${opts.charts ? '<script defer src="/js/chart.min.js"></script>' : ''}
</head>
<body>
  <header class="site-header">
    <div class="brand">
      <a href="/"><img src="/img/logo-120.png" alt="C-LARS" class="brand-logo"><strong>PMS</strong></a>
    </div>
    <nav class="site-nav">
      ${navLink('/opportunities', 'Opportunities', activeNav)}
      ${navLink('/quotes', 'Quotes', activeNav)}
      ${navLink('/activities', 'Tasks', activeNav)}
      ${navLink('/documents/library', 'Documents', activeNav)}
      ${navLink('/library', 'Library', activeNav)}
      ${navLink('/reports', 'Reports', activeNav)}
      ${navLink('/accounts', 'Accounts', activeNav)}
      ${navLink('/jobs', 'Jobs', activeNav)}
    </nav>
    <div class="header-right">
      ${user ? `<a href="/notifications" class="notification-bell" aria-label="Notifications" x-data>
        <svg class="notification-bell-icon" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
          <path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6V11a6 6 0 0 0-4.5-5.81V5a1.5 1.5 0 0 0-3 0v.19A6 6 0 0 0 6 11v5l-2 2v1h16v-1l-2-2z"/>
        </svg>
        <span class="notification-badge" x-show="$store.notifications && $store.notifications.count > 0" x-text="$store.notifications && $store.notifications.count" x-cloak></span>
      </a>` : ''}
      <div class="user-badge">
        ${user ? `<span class="user-name">${escape(user.display_name ?? user.email)}</span>
                   <span class="user-role">${escape(user.email ?? '')} · ${escape(user.role)}</span>` : '<span>Not signed in</span>'}
      </div>
    </div>
    <img src="/img/beta_banner.png" alt="BETA VERSION" class="beta-banner">
  </header>
  ${user ? `<div class="notification-toast-stack" x-data x-cloak>
    <template x-for="toast in ($store.notifications && $store.notifications.toasts) || []" :key="toast.id">
      <div class="notification-toast" @click="$store.notifications.clickToast(toast)">
        <button type="button" class="notification-toast-close" @click.stop="$store.notifications.dismissToast(toast)" aria-label="Dismiss">&times;</button>
        <div class="notification-toast-title" x-text="toast.title"></div>
        <div class="notification-toast-body" x-show="toast.body" x-text="toast.body"></div>
      </div>
    </template>
  </div>
  ${TASK_MODAL_MARKUP}` : ''}
  ${flash ? `<div class="flash flash-${escape(flash.kind ?? 'info')}">${escape(flash.message)}</div>` : ''}
  <main class="site-main">
${breadcrumbHtml}
${body}
  </main>
  <footer class="site-footer">
    <small>C-LARS Pipeline Management System</small>
  </footer>
  ${versionTag ? `<div class="version-badge">${versionTag}</div>` : ''}
  ${user ? `<script>${NOTIFICATION_STORE_SCRIPT}${TASK_MODAL_SCRIPT}</script>` : ''}
</body>
</html>`;
}

function navLink(href, label, active) {
  const isActive = active && href.startsWith(active);
  return `<a href="${href}" class="${isActive ? 'nav-link active' : 'nav-link'}">${escape(label)}</a>`;
}

/**
 * Convenience: build a standard HTML response with the layout shell.
 */
export function htmlResponse(body, init = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...(init.headers ?? {}),
    },
  });
}

/**
 * Convenience: build a 401 response shell (used by middleware when
 * Access headers are missing in production).
 */
export function unauthorizedResponse() {
  const body = layout('Unauthorized', `
    <section class="card">
      <h1>Unauthorized</h1>
      <p>
        This application is protected by Cloudflare Access. Please sign in
        via <a href="/">SSO</a> with your <code>@c-lars.com</code> account.
      </p>
    </section>
  `);
  return new Response(body, {
    status: 401,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
