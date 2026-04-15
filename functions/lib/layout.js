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
      ${user ? `<a href="/settings" class="header-settings" aria-label="Settings" title="Settings">
        <svg class="header-settings-icon" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
          <path d="M19.14 12.94c.04-.31.06-.62.06-.94 0-.32-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.5.5 0 0 0-.58-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.48.48 0 0 0-.58.22L2.74 8.87a.49.49 0 0 0 .12.61l2.03 1.58c-.04.31-.06.62-.06.94 0 .32.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.39.31.6.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.25.41.49.41h3.84c.24 0 .45-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.23.09.5 0 .6-.22l1.92-3.32c.12-.22.07-.49-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 0 1 8.4 12 3.6 3.6 0 0 1 12 8.4a3.6 3.6 0 0 1 3.6 3.6 3.6 3.6 0 0 1-3.6 3.6z"/>
        </svg>
      </a>` : ''}
      <div class="user-badge">
        ${user ? `<span class="user-name">${escape(user.display_name ?? user.email)}</span>
                   <span class="user-role">${escape(user.email ?? '')} · ${escape(user.role)}</span>` : '<span>Not signed in</span>'}
      </div>
    </div>
  </header>
  ${user ? `<div class="notification-toast-stack" x-data x-cloak>
    <template x-for="toast in ($store.notifications && $store.notifications.toasts) || []" :key="toast.id">
      <div class="notification-toast" @click="$store.notifications.clickToast(toast)">
        <button type="button" class="notification-toast-close" @click.stop="$store.notifications.dismissToast(toast)" aria-label="Dismiss">&times;</button>
        <div class="notification-toast-title" x-text="toast.title"></div>
        <div class="notification-toast-body" x-show="toast.body" x-text="toast.body"></div>
      </div>
    </template>
  </div>` : ''}
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
