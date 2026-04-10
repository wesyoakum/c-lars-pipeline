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

/**
 * Full-page HTML shell: includes nav, user badge, and slot for body.
 * Vendored HTMX + Alpine from /js so Access + CSP don't fight CDN cross-origin.
 */
export function layout(title, body, opts = {}) {
  const { user, flash, activeNav } = opts;
  const pageTitle = title ? `${escape(title)} — C-LARS PMS` : 'C-LARS PMS';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${pageTitle}</title>
  <link rel="stylesheet" href="/css/pms.css">
  <script defer src="/js/htmx.min.js"></script>
  <script defer src="/js/alpine.min.js"></script>
</head>
<body>
  <header class="site-header">
    <div class="brand">
      <a href="/"><strong>C-LARS PMS</strong></a>
      <span class="env-badge env-${escape(opts.env ?? 'prod')}">${escape(opts.env ?? 'prod')}</span>
    </div>
    <nav class="site-nav">
      ${navLink('/opportunities', 'Opportunities', activeNav)}
      ${navLink('/accounts', 'Accounts', activeNav)}
      ${navLink('/jobs', 'Jobs', activeNav)}
      ${navLink('/activities', 'Tasks', activeNav)}
      ${navLink('/settings', 'Settings', activeNav)}
    </nav>
    <div class="user-badge">
      ${user ? `<span class="user-name">${escape(user.display_name ?? user.email)}</span>
                 <span class="user-role">${escape(user.role)}</span>` : '<span>Not signed in</span>'}
    </div>
  </header>
  ${flash ? `<div class="flash flash-${escape(flash.kind ?? 'info')}">${escape(flash.message)}</div>` : ''}
  <main class="site-main">
${body}
  </main>
  <footer class="site-footer">
    <small>C-LARS PMS P0 · <a href="https://github.com/wesyoakum/pms">source</a></small>
  </footer>
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
