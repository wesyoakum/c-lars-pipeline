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

// Global wizard modal — Alpine store + injected markup.
//
// One modal, many wizards. Each wizard (task, account, contact,
// opportunity, quote, job) is a small config file under /js/wizards/
// that registers itself with the engine in /js/wizard-modal.js.
//
// Opened via:
//   <button onclick="window.PMS.openWizard('task', { opportunity_id: '...' })">+ Task</button>
//   <button onclick="window.PMS.openWizard('account', {})">+ New account</button>
//
// or via a custom event:
//   window.dispatchEvent(new CustomEvent('pms:open-wizard',
//     { detail: { key: 'account', prefill: {} } }))
//
// Back-compat: window.PMS.openTaskModal(prefill) maps to openWizard('task', prefill).
//
// Picker data (users, open opps, recent quotes, accounts) is fetched
// lazily from /activities/picker-data the first time a wizard with a
// user-select or entity-select step opens on a page.
//
// All wizard logic (date parsing, fuzzy match, step state, submit)
// lives in /js/wizard-modal.js. This markup is just the static DOM.
// Uses string concatenation (no template literals) so it drops into
// layout()'s shell without escaping issues.
const WIZARD_MODAL_MARKUP = (
  '<div class="task-modal-overlay" x-data x-show="$store.wizard.open" x-cloak ' +
  '@keydown.escape.window="$store.wizard.closeModal()" ' +
  '@click.self="$store.wizard.closeModal()" style="display:none">' +
  '<div class="task-modal task-modal-wizard" @click.stop>' +
  '<div class="task-modal-header">' +
  '<h3 x-text="$store.wizard.title()"></h3>' +
  '<button type="button" class="task-modal-close" @click="$store.wizard.closeModal()" aria-label="Close">&times;</button>' +
  '</div>' +
  '<div class="task-modal-body">' +

  // Pinned row (e.g. "Linked to: <record>") — only shown if the wizard
  // config's applyPrefill returned { locked: true, label: ... }.
  '<div class="task-wizard-pinned" x-show="$store.wizard.pinnedValue">' +
  '<span class="task-wizard-pinned-label" x-text="$store.wizard.pinnedPrefix"></span>' +
  '<strong x-text="$store.wizard.pinnedValue"></strong>' +
  '</div>' +

  // Big prompt (the current step's question)
  '<div class="task-wizard-prompt" x-text="$store.wizard.currentPrompt()"></div>' +

  // Input area: textarea / text input / select depending on step.type.
  '<div class="task-wizard-input-wrap">' +

  // Textarea (multi-line text)
  '<template x-if="$store.wizard.isMultilineStep()">' +
  '<textarea id="wizard-input" class="task-wizard-input task-wizard-input-textarea" ' +
  'x-model="$store.wizard.typedInput" ' +
  '@input="$store.wizard.onInputChange()" ' +
  '@keydown.tab.prevent="$store.wizard.advance()" ' +
  '@keydown.shift.tab.prevent="$store.wizard.goBack()" ' +
  'rows="3" ' +
  ':placeholder="$store.wizard.currentPlaceholder()" autocomplete="off"></textarea>' +
  '</template>' +

  // Select (dropdown)
  '<template x-if="$store.wizard.isSelectStep()">' +
  '<select id="wizard-input" class="task-wizard-input" ' +
  'x-model="$store.wizard.typedInput" ' +
  '@keydown.tab.prevent="$store.wizard.advance()" ' +
  '@keydown.shift.tab.prevent="$store.wizard.goBack()" ' +
  '@keydown.enter.prevent="$store.wizard.advance()">' +
  '<template x-for="opt in $store.wizard.selectOptions()" :key="opt.value">' +
  '<option :value="opt.value" x-text="opt.label"></option>' +
  '</template>' +
  '</select>' +
  '</template>' +

  // Single-line input (text / date / user-select / entity-select)
  '<template x-if="!$store.wizard.isMultilineStep() && !$store.wizard.isSelectStep()">' +
  '<input id="wizard-input" class="task-wizard-input" type="text" ' +
  'x-model="$store.wizard.typedInput" ' +
  '@input="$store.wizard.onInputChange()" ' +
  '@keydown.tab.prevent="$store.wizard.advance()" ' +
  '@keydown.shift.tab.prevent="$store.wizard.goBack()" ' +
  '@keydown.enter.prevent="$store.wizard.advance()" ' +
  '@keydown.arrow-down.prevent="$store.wizard.moveSuggestion(1)" ' +
  '@keydown.arrow-up.prevent="$store.wizard.moveSuggestion(-1)" ' +
  ':placeholder="$store.wizard.currentPlaceholder()" autocomplete="off">' +
  '</template>' +

  // Suggestions dropdown (user-select + entity-select steps).
  '<div class="task-wizard-suggestions" x-show="$store.wizard.visibleSuggestions().length > 0">' +
  '<template x-for="(sug, idx) in $store.wizard.visibleSuggestions()" :key="sug.id">' +
  '<button type="button" class="task-wizard-suggestion" ' +
  ':class="idx === $store.wizard.suggestionIndex ? \'active\' : \'\'" ' +
  '@mouseenter="$store.wizard.suggestionIndex = idx" ' +
  '@click="$store.wizard.pickSuggestion(idx)">' +
  '<span class="task-wizard-suggestion-type" x-text="sug.typeLabel" x-show="sug.typeLabel"></span>' +
  '<span class="task-wizard-suggestion-main" x-text="sug.label"></span>' +
  '<span class="task-wizard-suggestion-sub" x-text="sug.sub" x-show="sug.sub"></span>' +
  '</button>' +
  '</template>' +
  '</div>' +

  '</div>' + // /.task-wizard-input-wrap

  // Action bar: hint on the left, Back + submit on the right.
  '<div class="task-wizard-actionbar">' +
  '<span class="task-wizard-help" x-text="$store.wizard.currentHint()"></span>' +
  '<div class="task-wizard-actions">' +
  '<button type="button" class="btn btn-sm" @click="$store.wizard.goBack()" ' +
  ':disabled="$store.wizard.stepIndex === 0 || $store.wizard.submitting" ' +
  'x-show="$store.wizard.stepIndex > 0">Back</button>' +
  '<button type="button" class="btn btn-sm primary" ' +
  '@click="$store.wizard.submit()" ' +
  ':disabled="!$store.wizard.canSubmit() || $store.wizard.submitting">' +
  '<span x-show="!$store.wizard.submitting" x-text="$store.wizard.submitLabel()"></span>' +
  '<span x-show="$store.wizard.submitting">Saving\u2026</span>' +
  '</button>' +
  '</div>' +
  '</div>' +

  // Error message
  '<div class="task-modal-error" x-show="$store.wizard.error" x-text="$store.wizard.error"></div>' +

  '</div>' + // /.task-modal-body
  '</div>' + // /.task-modal
  '</div>'   // /.task-modal-overlay
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
  <!-- wizard-modal.js (engine) + per-wizard configs MUST load before
       alpine.min.js. Alpine 3's bundle auto-calls Alpine.start() as
       soon as it parses, which fires 'alpine:init' synchronously. Any
       listener added after that is too late and the store never
       registers. Defer preserves source-order execution. -->
  <script defer src="/js/wizard-modal.js"></script>
  <script defer src="/js/wizards/task.js"></script>
  <script defer src="/js/wizards/account.js"></script>
  <script defer src="/js/alpine.min.js"></script>
  <script defer src="/js/live-calc.js"></script>
  <script defer src="/js/account-picker.js"></script>
  <script defer src="/js/table-resize.js"></script>
  ${opts.charts ? '<script defer src="/js/chart.min.js"></script>' : ''}
</head>
<body>
  <header class="site-header">
    <div class="brand">
      <a href="/"><img src="/img/logo-120.png" alt="C-LARS" class="brand-logo"><strong>PMS</strong></a>
    </div>
    <nav class="site-nav">
      ${navLink('/accounts', 'Accounts', activeNav)}
      ${navLink('/opportunities', 'Opportunities', activeNav)}
      ${navLink('/quotes', 'Quotes', activeNav)}
      ${navLink('/activities', 'Tasks', activeNav)}
      ${navLink('/documents/library', 'Documents', activeNav)}
      ${navLink('/library', 'Library', activeNav)}
      ${navLink('/reports', 'Reports', activeNav)}
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
  ${WIZARD_MODAL_MARKUP}` : ''}
  ${flash ? `<div class="flash flash-${escape(flash.kind ?? 'info')}">${escape(flash.message)}</div>` : ''}
  <main class="site-main">
${breadcrumbHtml}
${body}
  </main>
  <footer class="site-footer">
    <small>C-LARS Pipeline Management System</small>
  </footer>
  ${versionTag ? `<div class="version-badge">${versionTag}</div>` : ''}
  ${user ? `<script>${NOTIFICATION_STORE_SCRIPT}</script>` : ''}
</body>
</html>`;
}

function navLink(href, label, active) {
  const isActive = active && href.startsWith(active);
  return `<a href="${href}" class="${isActive ? 'nav-link active' : 'nav-link'}">${escape(label)}</a>`;
}

/**
 * Sub-navigation tab strip. Renders a horizontal row of tab-styled links,
 * one of which is marked active by comparing its href to `activePath`.
 *
 * Use this for intra-section navigation like /accounts ↔ /accounts/contacts,
 * where both pages live under the same top-level nav (Accounts) but show
 * different tables. Each tab is a plain server-side navigation — no Alpine,
 * no client tab component.
 *
 * tabs: [{ href, label }, …]
 */
export function subnavTabs(tabs, activePath) {
  return html`<nav class="subnav-tabs" aria-label="Section tabs">
    ${tabs.map(t => {
      const isActive = t.href === activePath;
      return html`<a href="${escape(t.href)}" class="${isActive ? 'subnav-tab active' : 'subnav-tab'}">${escape(t.label)}</a>`;
    })}
  </nav>`;
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
