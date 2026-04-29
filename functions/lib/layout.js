// functions/lib/layout.js
//
// Small server-side HTML layout helper. Pipeline is rendered as plain HTML
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
// Back-to-top floating button. Shows once the page has scrolled far
// enough to justify it; a click smooth-scrolls window to the top. A
// secondary threshold keeps the button hidden on short pages (no
// point in a back-to-top when the whole page fits). Written as a
// plain string (no backticks) so it drops cleanly into the layout
// template literal.
const BACK_TO_TOP_SCRIPT = (
  "(function () {\n" +
  "  // Keep the --site-header-h CSS variable in sync with the actual\n" +
  "  // rendered header height so the sticky thead and sticky hscroll\n" +
  "  // proxy park flush against the bottom of .site-header on every\n" +
  "  // viewport (mobile wrapping, zoom, etc).\n" +
  "  var header = document.querySelector('.site-header');\n" +
  "  function syncHeaderVar() {\n" +
  "    if (!header) return;\n" +
  "    var h = header.offsetHeight;\n" +
  "    if (h > 0) document.documentElement.style.setProperty('--site-header-h', h + 'px');\n" +
  "  }\n" +
  "  syncHeaderVar();\n" +
  "  window.addEventListener('resize', syncHeaderVar);\n" +
  "  if (window.ResizeObserver && header) { try { new ResizeObserver(syncHeaderVar).observe(header); } catch (_) {} }\n" +
  "\n" +
  "  var btn = document.querySelector('.back-to-top');\n" +
  "  if (!btn) return;\n" +
  "  // Show the back-to-top button whenever a sticky table header is\n" +
  "  // currently pinned to the top of the viewport, OR on pages without\n" +
  "  // a list table once the user has scrolled a meaningful amount.\n" +
  "  var SHOW_AT = 150;\n" +
  "  function update() {\n" +
  "    var headerH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--site-header-h'), 10) || 53;\n" +
  "    var threshold = headerH + 14;\n" +
  "    var lists = document.querySelectorAll('.opp-list');\n" +
  "    var pinnedRect = null;\n" +
  "    for (var i = 0; i < lists.length; i++) {\n" +
  "      var r = lists[i].getBoundingClientRect();\n" +
  "      // Thead is pinned when the list has scrolled past the sticky\n" +
  "      // threshold AND the table bottom is still below it.\n" +
  "      if (r.top < threshold && r.bottom > threshold + 40) { pinnedRect = r; break; }\n" +
  "    }\n" +
  "    var y = window.scrollY || document.documentElement.scrollTop || 0;\n" +
  "    var show = !!pinnedRect || (lists.length === 0 && y > SHOW_AT);\n" +
  "    btn.dataset.visible = show ? '1' : '0';\n" +
  "    if (pinnedRect) {\n" +
  "      // Center over the table that's currently sticky-pinned.\n" +
  "      btn.style.left = (pinnedRect.left + pinnedRect.width / 2) + 'px';\n" +
  "    } else {\n" +
  "      btn.style.left = '';\n" +
  "    }\n" +
  "  }\n" +
  "  btn.addEventListener('click', function () {\n" +
  "    window.scrollTo({ top: 0, behavior: 'smooth' });\n" +
  "  });\n" +
  "  window.addEventListener('scroll', update, { passive: true });\n" +
  "  update();\n" +
  "\n" +
  "  // Auto-download trigger. When a handler redirects with\n" +
  "  // ?download=<documentId>, fire a download of that doc via a hidden\n" +
  "  // anchor, then strip the query param so a refresh doesn't repeat\n" +
  "  // it. Used by quote issue + OC issue to deliver the generated PDF.\n" +
  "  try {\n" +
  "    var u = new URL(window.location.href);\n" +
  "    var dlId = u.searchParams.get('download');\n" +
  "    if (dlId) {\n" +
  "      u.searchParams.delete('download');\n" +
  "      var clean = u.pathname + (u.searchParams.toString() ? '?' + u.searchParams.toString() : '') + u.hash;\n" +
  "      window.history.replaceState({}, '', clean);\n" +
  "      var a = document.createElement('a');\n" +
  "      a.href = '/documents/' + encodeURIComponent(dlId) + '/download';\n" +
  "      a.rel = 'noopener';\n" +
  "      a.style.display = 'none';\n" +
  "      document.body.appendChild(a);\n" +
  "      a.click();\n" +
  "      setTimeout(function () { a.remove(); }, 2000);\n" +
  "    }\n" +
  "  } catch (_) {}\n" +
  "})();\n"
);

// Hamburger nav toggle. On mobile (≤ 800px wide), .site-nav is hidden
// by default and slides down as a drawer when the toggle button is
// tapped. Outside-click and link-click both close the drawer. The
// button only renders interactively on mobile via CSS; on desktop
// the nav is always visible and this script does nothing useful.
const NAV_TOGGLE_SCRIPT = (
  "(function () {\n" +
  "  var toggle = document.querySelector('.nav-toggle');\n" +
  "  var nav = document.querySelector('.site-nav');\n" +
  "  if (!toggle || !nav) return;\n" +
  "  function setOpen(open) {\n" +
  "    nav.classList.toggle('is-open', open);\n" +
  "    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');\n" +
  "  }\n" +
  "  toggle.addEventListener('click', function (e) {\n" +
  "    e.stopPropagation();\n" +
  "    setOpen(!nav.classList.contains('is-open'));\n" +
  "  });\n" +
  "  document.addEventListener('click', function (e) {\n" +
  "    if (!nav.classList.contains('is-open')) return;\n" +
  "    if (toggle.contains(e.target) || nav.contains(e.target)) return;\n" +
  "    setOpen(false);\n" +
  "  });\n" +
  "  nav.addEventListener('click', function (e) {\n" +
  "    if (e.target.closest && e.target.closest('a')) setOpen(false);\n" +
  "  });\n" +
  "  // Close the drawer if the viewport widens past the breakpoint —\n" +
  "  // otherwise an open mobile drawer would visually persist on a\n" +
  "  // desktop after a rotate / resize.\n" +
  "  window.addEventListener('resize', function () {\n" +
  "    if (window.innerWidth > 800 && nav.classList.contains('is-open')) setOpen(false);\n" +
  "  });\n" +
  "})();\n"
);

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
//   <button onclick="window.Pipeline.openWizard('task', { opportunity_id: '...' })">+ Task</button>
//   <button onclick="window.Pipeline.openWizard('account', {})">+ New account</button>
//
// or via a custom event:
//   window.dispatchEvent(new CustomEvent('pipeline:open-wizard',
//     { detail: { key: 'account', prefill: {} } }))
//
// Back-compat: window.Pipeline.openTaskModal(prefill) maps to openWizard('task', prefill).
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
  '<span class="task-wizard-step-indicator" x-text="$store.wizard.stepProgressLabel()" ' +
  'x-show="$store.wizard.phase === \'steps\' && $store.wizard.stepProgressLabel()"></span>' +
  '<button type="button" class="task-modal-close" @click="$store.wizard.closeModal()" aria-label="Close">&times;</button>' +
  '</div>' +
  '<div class="task-modal-body">' +

  // -------- Smart-start phase ---------
  // Only rendered when the active wizard config has `smartStart: true`.
  // Captures unstructured input (text now; photo coming next), POSTs
  // to /ai-inbox/new for extraction, then maps the result into the
  // wizard's answers and switches to the standard step UI.
  '<div class="task-wizard-smartstart" x-show="$store.wizard.phase === \'smart-start\'">' +
  '<p class="task-wizard-smartstart-title">Quick start <small class="muted">(optional)</small></p>' +
  '<p class="task-wizard-smartstart-hint" x-text="$store.wizard.smartStartHint()"></p>' +
  '<textarea class="task-wizard-smartstart-text" x-model="$store.wizard.smartStartText" ' +
  'rows="4" autocomplete="off" ' +
  ':disabled="$store.wizard.smartStartBusy" ' +
  ':placeholder="$store.wizard.smartStartPlaceholder()"></textarea>' +
  '<input type="file" accept="image/*" x-ref="smartstart_photo" hidden ' +
  '@change="$store.wizard.runSmartStartFromFile($event.target.files[0])">' +
  '<div class="task-wizard-smartstart-actions">' +
  '<button type="button" class="btn btn-sm" ' +
  '@click="$refs.smartstart_photo && $refs.smartstart_photo.click()" ' +
  ':disabled="$store.wizard.smartStartBusy">📷 Photo</button>' +
  '<button type="button" class="btn btn-sm primary" ' +
  '@click="$store.wizard.runSmartStart()" ' +
  ':disabled="$store.wizard.smartStartBusy || !($store.wizard.smartStartText && $store.wizard.smartStartText.trim())">' +
  '<span x-show="!$store.wizard.smartStartBusy">Use AI</span>' +
  '<span x-show="$store.wizard.smartStartBusy">Extracting…</span>' +
  '</button>' +
  '<button type="button" class="btn btn-sm task-wizard-smartstart-skip" ' +
  '@click="$store.wizard.skipSmartStart()" ' +
  ':disabled="$store.wizard.smartStartBusy">Skip</button>' +
  '</div>' +
  '<div class="task-wizard-smartstart-error" x-show="$store.wizard.smartStartError" x-text="$store.wizard.smartStartError"></div>' +
  '</div>' +

  // -------- Review phase (Phase 5a — cascade planner) ---------
  // Shown when the wizard config has `plan: true` and /wizards/plan
  // returned a structured plan. Lets the user toggle individual
  // operations before hitting Confirm and Create.
  '<div class="task-wizard-review" x-show="$store.wizard.phase === \'review\' && $store.wizard.plan" x-cloak>' +

  // Plan summary — one-line narrative ("First we'll add the new
  // account ... then create ... as a contact at it.") so the user
  // sees the cascade ordering in plain language at a glance.
  '<p class="task-wizard-review-summary" x-text="$store.wizard.planSummary()" ' +
  'x-show="$store.wizard.planSummary()"></p>' +

  // Account section
  '<template x-if="$store.wizard.plan && $store.wizard.plan.account && ($store.wizard.plan.account.matched || $store.wizard.plan.account.proposed_new)">' +
  '<div class="task-wizard-review-section">' +
  '<div class="task-wizard-review-section-head">' +
  '<span class="task-wizard-review-kind">Account</span>' +
  '<template x-if="$store.wizard.plan.account.matched">' +
  '<span class="task-wizard-review-status existing">' +
  '<strong x-text="$store.wizard.plan.account.matched.alias || $store.wizard.plan.account.matched.name"></strong>' +
  '<small class="muted">existing</small>' +
  '</span>' +
  '</template>' +
  '<template x-if="$store.wizard.plan.account.proposed_new">' +
  '<span class="task-wizard-review-status new">' +
  '<strong x-text="$store.wizard.plan.account.proposed_new.name"></strong>' +
  '<small class="muted">will be created</small>' +
  '</span>' +
  '</template>' +
  '</div>' +
  // Push candidates for the account. Address rows render with two
  // sub-toggles (Physical / Billing) instead of a single checkbox —
  // either, both, or neither selectable.
  '<div class="task-wizard-review-fields" x-show="$store.wizard.plan.account.push_candidates.length > 0">' +
  '<template x-for="(c, idx) in $store.wizard.plan.account.push_candidates" :key="\'a\' + idx">' +
  '<div>' +
  '<template x-if="c.field !== \'address\'">' +
  '<label class="task-wizard-review-field" :class="{ conflict: c.conflict }">' +
  '<input type="checkbox" :checked="c.checked" @change="$store.wizard.togglePushCandidate(\'account\', idx)">' +
  '<span class="task-wizard-review-field-name" x-text="c.field"></span>' +
  '<span class="task-wizard-review-field-proposed" x-text="c.proposed"></span>' +
  '<span class="task-wizard-review-field-current" x-show="c.conflict">(current: <span x-text="c.current || \'(empty)\'"></span>)</span>' +
  '</label>' +
  '</template>' +
  '<template x-if="c.field === \'address\'">' +
  '<div class="task-wizard-review-field task-wizard-review-field-address" :class="{ conflict: c.conflict }">' +
  '<span class="task-wizard-review-field-name">address</span>' +
  '<span class="task-wizard-review-field-proposed task-wizard-review-address-text" x-text="c.proposed"></span>' +
  '<div class="task-wizard-review-address-kinds">' +
  '<label><input type="checkbox" x-model="c.address_physical"> Physical</label>' +
  '<label><input type="checkbox" x-model="c.address_billing"> Billing</label>' +
  '</div>' +
  '<span class="task-wizard-review-field-current" x-show="c.conflict">(current: <span x-text="c.current || \'(empty)\'"></span>)</span>' +
  '</div>' +
  '</template>' +
  '</div>' +
  '</template>' +
  '</div>' +
  '</div>' +
  '</template>' +

  // Contact section
  '<template x-if="$store.wizard.plan && $store.wizard.plan.contact && ($store.wizard.plan.contact.matched || $store.wizard.plan.contact.proposed_new)">' +
  '<div class="task-wizard-review-section">' +
  '<div class="task-wizard-review-section-head">' +
  '<span class="task-wizard-review-kind">Contact</span>' +
  '<template x-if="$store.wizard.plan.contact.matched">' +
  '<span class="task-wizard-review-status existing">' +
  '<strong x-text="($store.wizard.plan.contact.matched.first_name || \'\') + \' \' + ($store.wizard.plan.contact.matched.last_name || \'\')"></strong>' +
  '<small class="muted">existing</small>' +
  '</span>' +
  '</template>' +
  '<template x-if="$store.wizard.plan.contact.proposed_new">' +
  '<span class="task-wizard-review-status new">' +
  '<strong x-text="($store.wizard.plan.contact.proposed_new.first_name || \'\') + \' \' + ($store.wizard.plan.contact.proposed_new.last_name || \'\')"></strong>' +
  '<small class="muted">will be created</small>' +
  '</span>' +
  '</template>' +
  '</div>' +
  '<div class="task-wizard-review-fields" x-show="$store.wizard.plan.contact.push_candidates.length > 0">' +
  '<template x-for="(c, idx) in $store.wizard.plan.contact.push_candidates" :key="\'c\' + idx">' +
  '<label class="task-wizard-review-field" :class="{ conflict: c.conflict }">' +
  '<input type="checkbox" :checked="c.checked" @change="$store.wizard.togglePushCandidate(\'contact\', idx)">' +
  '<span class="task-wizard-review-field-name" x-text="c.field"></span>' +
  '<span class="task-wizard-review-field-proposed" x-text="c.proposed"></span>' +
  '<span class="task-wizard-review-field-current" x-show="c.conflict">(current: <span x-text="c.current || \'(empty)\'"></span>)</span>' +
  '</label>' +
  '</template>' +
  '</div>' +
  '</div>' +
  '</template>' +

  // Opportunity section (Phase 5c-1) — editable form fields, not
  // checkbox-style. Bound directly to plan.opportunity.proposed_new
  // via x-model. Title and transaction_type are required —
  // confirmDisabled() guards the Confirm button until both are set.
  '<template x-if="$store.wizard.plan && $store.wizard.plan.opportunity && $store.wizard.plan.opportunity.proposed_new">' +
  '<div class="task-wizard-review-section">' +
  '<div class="task-wizard-review-section-head">' +
  '<span class="task-wizard-review-kind">Opportunity</span>' +
  '<span class="task-wizard-review-status new"><strong>will be created</strong></span>' +
  '</div>' +
  '<div class="task-wizard-review-form">' +
  '<label class="task-wizard-review-input-row">' +
  '<span>Title <em class="req">*</em></span>' +
  '<input type="text" x-model="$store.wizard.plan.opportunity.proposed_new.title" required>' +
  '</label>' +
  '<label class="task-wizard-review-input-row">' +
  '<span>Type <em class="req">*</em></span>' +
  '<select x-model="$store.wizard.plan.opportunity.proposed_new.transaction_type" required>' +
  '<option value="">— Pick a type —</option>' +
  '<option value="spares">Spares</option>' +
  '<option value="eps">Engineered Product (EPS)</option>' +
  '<option value="refurb">Refurbishment</option>' +
  '<option value="service">Service</option>' +
  '</select>' +
  '</label>' +
  '<label class="task-wizard-review-input-row">' +
  '<span>Value (USD)</span>' +
  '<input type="text" x-model="$store.wizard.plan.opportunity.proposed_new.estimated_value_usd" placeholder="optional">' +
  '</label>' +
  '<label class="task-wizard-review-input-row">' +
  '<span>Description</span>' +
  '<textarea x-model="$store.wizard.plan.opportunity.proposed_new.description" rows="3" placeholder="optional"></textarea>' +
  '</label>' +
  '</div>' +
  '</div>' +
  '</template>' +

  // Action bar
  '<div class="task-wizard-review-actions">' +
  '<button type="button" class="btn btn-sm task-wizard-review-edit" ' +
  '@click="$store.wizard.editManually()" ' +
  ':disabled="$store.wizard.executing">Edit manually</button>' +
  '<button type="button" class="btn btn-sm primary task-wizard-review-confirm" ' +
  '@click="$store.wizard.confirmPlan()" ' +
  ':disabled="$store.wizard.confirmDisabled()">' +
  '<span x-show="!$store.wizard.executing" x-text="$store.wizard.confirmButtonLabel()"></span>' +
  '<span x-show="$store.wizard.executing">Working…</span>' +
  '</button>' +
  '</div>' +

  '</div>' +

  // -------- Steps phase ---------
  '<div x-show="$store.wizard.phase === \'steps\'">' +

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

  // "Show inactive" override for entity-select steps, shown only when
  // the global active_only pref is on (otherwise everything's visible
  // anyway and the checkbox would be a no-op). Re-fetches picker-data
  // with ?include_inactive=1 the first time it's ticked.
  '<label class="task-wizard-show-inactive" x-show="$store.wizard.shouldOfferInactiveToggle()">' +
  '<input type="checkbox" :checked="$store.wizard.showInactive" ' +
  '@change="$store.wizard.toggleShowInactive($event.target.checked)"> ' +
  '<span>Show inactive</span>' +
  '</label>' +

  // Suggestions dropdown (user-select + entity-select steps).
  '<div class="task-wizard-suggestions" x-show="$store.wizard.visibleSuggestions().length > 0">' +
  '<template x-for="(sug, idx) in $store.wizard.visibleSuggestions()" :key="sug.id">' +
  '<button type="button" class="task-wizard-suggestion" ' +
  ':class="(idx === $store.wizard.suggestionIndex ? \'active \' : \'\') + ((sug._item && sug._item.active === 0) ? \'inactive\' : \'\')" ' +
  '@mouseenter="$store.wizard.suggestionIndex = idx" ' +
  '@click="$store.wizard.pickSuggestion(idx)">' +
  '<span class="task-wizard-suggestion-type" x-text="sug.typeLabel" x-show="sug.typeLabel"></span>' +
  '<span class="task-wizard-suggestion-main" x-text="sug.label"></span>' +
  '<span class="task-wizard-suggestion-sub" x-text="sug.sub" x-show="sug.sub"></span>' +
  '<span class="task-wizard-suggestion-inactive-badge" x-show="sug._item && sug._item.active === 0">inactive</span>' +
  '</button>' +
  '</template>' +
  '</div>' +

  '</div>' + // /.task-wizard-input-wrap

  // Action bar: hint on the left, Back + Next/Submit on the right.
  // The primary button auto-flips between "Next" (advance) and the
  // wizard's submit label (e.g. "Create contact") on the last step.
  // Tab/Enter still work for keyboard users \u2014 these buttons are the
  // touch equivalent.
  '<div class="task-wizard-actionbar">' +
  '<span class="task-wizard-help" x-text="$store.wizard.currentHint()"></span>' +
  '<div class="task-wizard-actions">' +
  '<button type="button" class="btn btn-sm task-wizard-back-btn" @click="$store.wizard.goBack()" ' +
  ':disabled="$store.wizard.stepIndex === 0 || $store.wizard.submitting" ' +
  'x-show="$store.wizard.stepIndex > 0">Back</button>' +
  '<button type="button" class="btn btn-sm primary task-wizard-primary-btn" ' +
  '@click="$store.wizard.primaryAction()" ' +
  ':disabled="$store.wizard.primaryDisabled()">' +
  '<span x-show="!$store.wizard.submitting" x-text="$store.wizard.primaryButtonLabel()"></span>' +
  '<span x-show="$store.wizard.submitting">Saving\u2026</span>' +
  '</button>' +
  '</div>' +
  '</div>' +

  '</div>' + // /steps phase wrapper

  // Error message (visible in either phase)
  '<div class="task-modal-error" x-show="$store.wizard.error" x-text="$store.wizard.error"></div>' +

  '</div>' + // /.task-modal-body
  '</div>' + // /.task-modal
  '</div>'   // /.task-modal-overlay
);

// Blocker modal — surfaces when a status-change that would inactivate
// an entity is refused by the server because the entity has pending
// tasks or active downstream objects (migration 0035 rule).
//
// Populated by window.Pipeline.showBlockerModal({
//   actionLabel: "Cancel this job",
//   error: "optional server-provided summary",
//   blockers: [{ kind, id, label, due_at?, resolveUrl, completeUrl? }],
//   retry: () => Promise — optional, called when the user clicks "Retry"
// });
//
// For each task blocker the modal offers inline "Mark complete" (hits
// completeUrl, removes the row on success). For downstream objects
// the user gets a link to resolve the blocker manually. When the list
// empties out, a big Retry button appears.
const BLOCKER_MODAL_MARKUP = (
  '<div class="task-modal-overlay blocker-modal-overlay" x-data ' +
  'x-show="$store.blockerModal.open" x-cloak ' +
  '@keydown.escape.window="$store.blockerModal.close()" ' +
  '@click.self="$store.blockerModal.close()" style="display:none">' +
  '<div class="task-modal blocker-modal" @click.stop>' +
  '<div class="task-modal-header">' +
  '<h3>Can\u2019t do that yet</h3>' +
  '<button type="button" class="task-modal-close" @click="$store.blockerModal.close()" aria-label="Close">&times;</button>' +
  '</div>' +
  '<div class="task-modal-body">' +
  '<p class="blocker-modal-intro">' +
  '<span x-text="$store.blockerModal.actionLabel || \'That change\'"></span> ' +
  'will leave these open. Resolve them first:' +
  '</p>' +

  // No blockers left → retry affordance.
  '<div class="blocker-modal-cleared" x-show="$store.blockerModal.blockers.length === 0">' +
  '<p>All clear.</p>' +
  '<button type="button" class="btn primary" @click="$store.blockerModal.retry()" ' +
  ':disabled="$store.blockerModal.retrying">' +
  '<span x-show="!$store.blockerModal.retrying">Retry</span>' +
  '<span x-show="$store.blockerModal.retrying">Retrying\u2026</span>' +
  '</button>' +
  '</div>' +

  // Blocker list.
  '<ul class="blocker-list" x-show="$store.blockerModal.blockers.length > 0">' +
  '<template x-for="b in $store.blockerModal.blockers" :key="b.kind + \':\' + b.id">' +
  '<li class="blocker-item" :class="\'blocker-kind-\' + b.kind">' +
  '<span class="blocker-kind-label" x-text="b.kind"></span>' +
  '<a class="blocker-label" :href="b.resolveUrl" x-text="b.label"></a>' +
  '<span class="blocker-due" x-show="b.due_at" x-text="\'due \' + b.due_at"></span>' +
  '<span class="blocker-actions">' +
  // Tasks get an inline Complete button.
  '<button type="button" class="btn btn-xs primary" ' +
  'x-show="b.completeUrl" ' +
  '@click="$store.blockerModal.completeTask(b)" ' +
  ':disabled="$store.blockerModal.resolving[b.kind + \':\' + b.id]">' +
  '<span x-show="!$store.blockerModal.resolving[b.kind + \':\' + b.id]">Complete</span>' +
  '<span x-show="$store.blockerModal.resolving[b.kind + \':\' + b.id]">\u2026</span>' +
  '</button>' +
  // Non-task blockers get an "Open" link instead of an action.
  '<a class="btn btn-xs" :href="b.resolveUrl" x-show="!b.completeUrl">Open</a>' +
  '</span>' +
  '</li>' +
  '</template>' +
  '</ul>' +

  '<div class="task-wizard-actionbar">' +
  '<span class="task-wizard-help" x-show="$store.blockerModal.lastError" x-text="$store.blockerModal.lastError"></span>' +
  '<button type="button" class="btn btn-sm" @click="$store.blockerModal.close()">Close</button>' +
  '</div>' +

  '</div>' +
  '</div>' +
  '</div>'
);

// Blocker modal Alpine store + global helper.
//
// window.Pipeline.showBlockerModal({ actionLabel, error, blockers, retry })
//   - actionLabel: the short verb-phrase being blocked ("Close this
//     opportunity", "Cancel this job"). Renders before the list.
//   - error: optional server-provided one-liner to show at the bottom.
//   - blockers: array of { kind, id, label, due_at?, resolveUrl, completeUrl? }
//   - retry: optional fn returning a Promise. Called when the user hits
//     Retry after clearing the list (and called automatically when the
//     list empties to length 0). If it resolves to { ok: false, blockers }
//     we repopulate the list (same flow as the original call).
//
// window.Pipeline.submitFormWithBlockerCheck(form, actionLabel)
//   - Intercepts a form submit, does a fetch with x-requested-with set,
//     and on 409 opens the blocker modal wired to retry the same POST.
//   - For <200 success, follows res.url (redirect target) or the form's
//     action.
//
// Also patches the inline-edit pipeline (in list-inline-edit.js) to
// surface blocker responses via this modal — that one stays there.
const BLOCKER_MODAL_STORE_SCRIPT = (
  "(function () {\n" +
  "  window.Pipeline = window.Pipeline || {};\n" +
  "  document.addEventListener('alpine:init', function () {\n" +
  "    Alpine.store('blockerModal', {\n" +
  "      open: false,\n" +
  "      blockers: [],\n" +
  "      actionLabel: '',\n" +
  "      lastError: '',\n" +
  "      _retry: null,\n" +
  "      retrying: false,\n" +
  "      resolving: {},\n" +
  "      openWith: function (opts) {\n" +
  "        opts = opts || {};\n" +
  "        this.blockers = (opts.blockers || []).slice();\n" +
  "        this.actionLabel = opts.actionLabel || '';\n" +
  "        this.lastError = opts.error || '';\n" +
  "        this._retry = typeof opts.retry === 'function' ? opts.retry : null;\n" +
  "        this.retrying = false;\n" +
  "        this.resolving = {};\n" +
  "        this.open = true;\n" +
  "      },\n" +
  "      close: function () {\n" +
  "        this.open = false;\n" +
  "        this.blockers = [];\n" +
  "        this.lastError = '';\n" +
  "        this._retry = null;\n" +
  "        this.resolving = {};\n" +
  "      },\n" +
  "      completeTask: function (b) {\n" +
  "        if (!b || !b.completeUrl) return;\n" +
  "        var self = this;\n" +
  "        var key = b.kind + ':' + b.id;\n" +
  "        self.resolving[key] = true;\n" +
  "        var fd = new FormData();\n" +
  "        fd.append('source', 'blocker-modal');\n" +
  "        fetch(b.completeUrl, {\n" +
  "          method: 'POST',\n" +
  "          credentials: 'same-origin',\n" +
  "          body: fd,\n" +
  "          headers: { 'x-requested-with': 'XMLHttpRequest', 'accept': 'application/json' }\n" +
  "        }).then(function (res) {\n" +
  "          // Task-complete endpoint doesn't always return JSON — any\n" +
  "          // 2xx means the task's gone from the pending list.\n" +
  "          if (!res.ok) throw new Error('HTTP ' + res.status);\n" +
  "          self.blockers = self.blockers.filter(function (x) {\n" +
  "            return !(x.kind === b.kind && x.id === b.id);\n" +
  "          });\n" +
  "          delete self.resolving[key];\n" +
  "          // Auto-retry once the list is empty.\n" +
  "          if (self.blockers.length === 0 && self._retry) {\n" +
  "            self.retry();\n" +
  "          }\n" +
  "        }).catch(function (err) {\n" +
  "          self.lastError = 'Could not complete task: ' + (err.message || err);\n" +
  "          delete self.resolving[key];\n" +
  "        });\n" +
  "      },\n" +
  "      retry: function () {\n" +
  "        if (!this._retry || this.retrying) return;\n" +
  "        var self = this;\n" +
  "        self.retrying = true;\n" +
  "        Promise.resolve()\n" +
  "          .then(function () { return self._retry(); })\n" +
  "          .then(function (result) {\n" +
  "            self.retrying = false;\n" +
  "            if (result && result.ok === false && Array.isArray(result.blockers)) {\n" +
  "              // Still blocked — refresh the list and stay open.\n" +
  "              self.blockers = result.blockers;\n" +
  "              self.lastError = result.error || '';\n" +
  "              return;\n" +
  "            }\n" +
  "            // Success — the retry function is responsible for its\n" +
  "            // own success behavior (redirect, reload, etc.). We just\n" +
  "            // close the modal.\n" +
  "            self.close();\n" +
  "          })\n" +
  "          .catch(function (err) {\n" +
  "            self.retrying = false;\n" +
  "            self.lastError = 'Retry failed: ' + (err.message || err);\n" +
  "          });\n" +
  "      }\n" +
  "    });\n" +
  "  });\n" +
  "\n" +
  "  // Shortcut consumers use everywhere.\n" +
  "  window.Pipeline.showBlockerModal = function (opts) {\n" +
  "    var store = (typeof Alpine !== 'undefined' && Alpine.store)\n" +
  "      ? Alpine.store('blockerModal') : null;\n" +
  "    if (!store) { console.error('blockerModal store not ready'); return; }\n" +
  "    store.openWith(opts || {});\n" +
  "  };\n" +
  "\n" +
  "  // Wrap a <form> submit: POST as AJAX, show modal on 409, navigate\n" +
  "  // on success. `actionLabel` is the user-facing verb phrase\n" +
  "  // (\"Close this opportunity\").\n" +
  "  window.Pipeline.submitFormWithBlockerCheck = function (form, actionLabel) {\n" +
  "    if (!form) return;\n" +
  "    var method = (form.method || 'POST').toUpperCase();\n" +
  "    var action = form.getAttribute('action') || window.location.pathname;\n" +
  "    var fd = new FormData(form);\n" +
  "    fd.append('source', 'blocker-check');\n" +
  "    function doSubmit() {\n" +
  "      return fetch(action, {\n" +
  "        method: method,\n" +
  "        credentials: 'same-origin',\n" +
  "        body: fd,\n" +
  "        redirect: 'follow',\n" +
  "        headers: { 'x-requested-with': 'XMLHttpRequest', 'accept': 'application/json' }\n" +
  "      }).then(function (res) {\n" +
  "        if (res.status === 409) {\n" +
  "          return res.json().then(function (data) {\n" +
  "            return { ok: false, blockers: data.blockers || [], error: data.error || '' };\n" +
  "          });\n" +
  "        }\n" +
  "        if (!res.ok) {\n" +
  "          return res.text().then(function () {\n" +
  "            throw new Error('HTTP ' + res.status);\n" +
  "          });\n" +
  "        }\n" +
  "        // Successful — follow redirect if the response took us somewhere.\n" +
  "        var target = res.url || action;\n" +
  "        window.location.href = target;\n" +
  "        return { ok: true };\n" +
  "      });\n" +
  "    }\n" +
  "    doSubmit().then(function (result) {\n" +
  "      if (result && result.ok === false) {\n" +
  "        window.Pipeline.showBlockerModal({\n" +
  "          actionLabel: actionLabel,\n" +
  "          error: result.error,\n" +
  "          blockers: result.blockers,\n" +
  "          retry: doSubmit\n" +
  "        });\n" +
  "      }\n" +
  "    }).catch(function (err) {\n" +
  "      alert('Could not submit: ' + (err.message || err));\n" +
  "    });\n" +
  "  };\n" +
  "})();\n"
);

// Board sidebars — split into two fixed-positioned panels that sit in
// the free space to the left and right of the centered .site-main
// content (max-width 1100px). Both share the same Alpine $store.board.
//
// Right panel:  Tasks (with click-to-toggle dots, hover "show complete")
//                + Notes (sticky-pad stack with inline composer/edit)
// Left  panel:  Messages (chat bubbles with always-open composer at bottom)
//
// Both panels are hidden via @media when the viewport doesn't have
// enough free margin to host them — the centered content always wins.
const BOARD_RIGHT_MARKUP = (
  '<div class="board-root board-root-right" x-data x-cloak>' +

  // (Restore button when collapsed lives in the header next to the
  // notification bell \u2014 see BOARD_RESTORE_HEADER_BTN.)

  '<aside class="board-sidebar board-sidebar-right" ' +
    'x-show="$store.board && !$store.board.isCollapsed" ' +
    'aria-label="Whiteboard sidebar">' +

    // ---------- Zone 1a: To-Do (overdue + today + tomorrow) ----------
    '<section class="board-zone board-zone-tasks" ' +
      ':class="$store.board.showCompleted ? \'board-tasks-show-done\' : \'\'">' +
      // Hide button \u2014 small chevron pointing right (toward the edge
      // the board collapses into). Lives on the topmost task card and
      // hides both sidebars for 5 min on click.
      '<button type="button" class="board-hide-peek" ' +
        '@click="$store.board.hideFor(5)" ' +
        'title="Hide board for 5 min" aria-label="Hide board">' +
        '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">' +
          '<polygon points="5,3 12,8 5,13"/>' +
        '</svg>' +
      '</button>' +
      '<h3 class="board-zone-heading">To-Do</h3>' +
      '<button type="button" class="board-tasks-toggle" ' +
        ':class="$store.board.showCompleted ? \'active\' : \'\'" ' +
        '@click="$store.board.toggleShowCompleted()" ' +
        'x-text="$store.board.showCompleted ? \'hide complete\' : \'show complete\'"></button>' +
      '<template x-if="$store.board.todoTasks.length === 0">' +
        '<p class="board-zone-empty">Nothing due today or tomorrow.</p>' +
      '</template>' +
      '<ul class="board-task-list">' +
        '<template x-for="t in $store.board.todoTasks" :key="t.id">' +
          '<li :class="$store.board.taskItemClass(t)">' +
            '<button type="button" class="board-task-dot" ' +
              ':title="t.status === \'completed\' ? \'Mark incomplete\' : \'Mark complete\'" ' +
              '@click.stop="$store.board.toggleTask(t)"></button>' +
            '<span class="board-task-prefix" ' +
              'x-text="$store.board.taskPrefix(t)" ' +
              'x-show="$store.board.taskPrefix(t)"></span>' +
            '<a :href="\'/activities\'" class="board-task-link">' +
              '<span class="board-task-text" ' +
                'x-html="$store.board.renderBody((t.subject || t.body || \'\'))"></span>' +
            '</a>' +
            '<button type="button" class="board-task-delete" ' +
              '@click.stop="$store.board.deleteTask(t)" ' +
              'title="Delete task" aria-label="Delete task">\u00D7</button>' +
          '</li>' +
        '</template>' +
      '</ul>' +
    '</section>' +

    // ---------- Zone 1b: Coming Soon (2\u20137 days out) ----------
    '<section class="board-zone board-zone-tasks">' +
      '<h3 class="board-zone-heading">Coming Soon</h3>' +
      '<template x-if="$store.board.comingSoonTasks.length === 0">' +
        '<p class="board-zone-empty">Nothing in the next week.</p>' +
      '</template>' +
      '<ul class="board-task-list">' +
        '<template x-for="t in $store.board.comingSoonTasks" :key="t.id">' +
          '<li :class="$store.board.taskItemClass(t)">' +
            '<button type="button" class="board-task-dot" ' +
              ':title="t.status === \'completed\' ? \'Mark incomplete\' : \'Mark complete\'" ' +
              '@click.stop="$store.board.toggleTask(t)"></button>' +
            '<span class="board-task-prefix" ' +
              'x-text="$store.board.taskPrefix(t)" ' +
              'x-show="$store.board.taskPrefix(t)"></span>' +
            '<a :href="\'/activities\'" class="board-task-link">' +
              '<span class="board-task-text" ' +
                'x-html="$store.board.renderBody((t.subject || t.body || \'\'))"></span>' +
            '</a>' +
            '<button type="button" class="board-task-delete" ' +
              '@click.stop="$store.board.deleteTask(t)" ' +
              'title="Delete task" aria-label="Delete task">\u00D7</button>' +
          '</li>' +
        '</template>' +
      '</ul>' +
    '</section>' +

    // ---------- Zone 2: Notes (sticky note pad) ----------
    '<section class="board-zone board-zone-notes">' +

      // Compose stack — five blank colored cards, or the active composer
      '<div class="board-notes-stack" x-show="!$store.board.composer.open">' +
        '<button type="button" class="board-stack-note board-stack-note-yellow" ' +
          'title="New yellow post-it" aria-label="New yellow post-it" ' +
          '@click="$store.board.openComposer({ color: \'yellow\' })"></button>' +
        '<button type="button" class="board-stack-note board-stack-note-pink" ' +
          'title="New pink post-it" aria-label="New pink post-it" ' +
          '@click="$store.board.openComposer({ color: \'pink\' })"></button>' +
        '<button type="button" class="board-stack-note board-stack-note-blue" ' +
          'title="New blue post-it" aria-label="New blue post-it" ' +
          '@click="$store.board.openComposer({ color: \'blue\' })"></button>' +
        '<button type="button" class="board-stack-note board-stack-note-green" ' +
          'title="New green post-it" aria-label="New green post-it" ' +
          '@click="$store.board.openComposer({ color: \'green\' })"></button>' +
        '<button type="button" class="board-stack-note board-stack-note-orange" ' +
          'title="New orange post-it" aria-label="New orange post-it" ' +
          '@click="$store.board.openComposer({ color: \'orange\' })"></button>' +
      '</div>' +

      // Active composer (slides over stack when open). Enter saves,
      // Escape cancels. No save/cancel buttons. Delete = X (top-right
      // on hover) which only appears when editing an existing card,
      // so the composer here doesn't show one.
      '<div :class="\'board-composer board-card board-card-color-\' + $store.board.composer.color" ' +
        'x-show="$store.board.composer.open" x-cloak>' +
        '<textarea id="board-composer-textarea" class="board-composer-textarea" ' +
          'rows="2" placeholder="Jot a post-it\u2026 (@ to link, Enter to save, Esc to cancel)" ' +
          ':value="$store.board.composer.body" ' +
          '@input="$store.board.onBodyInput(\'composer\', $event.target)" ' +
          '@keydown="$store.board.onBodyKeydown(\'composer\', $event.target, $event)"></textarea>' +
        '<div class="board-mention-popup" ' +
          'x-show="$store.board.mention.active && $store.board.mention.for === \'composer\' && $store.board.mention.results.length" x-cloak>' +
          '<template x-for="(r, i) in $store.board.mention.results" :key="r.ref_type + r.ref_id">' +
            '<button type="button" class="board-mention-opt" ' +
              ':class="{ active: i === $store.board.mention.selectedIndex }" ' +
              '@click="$store.board.pickMention(r, document.getElementById(\'board-composer-textarea\'))">' +
              '<span class="board-mention-type" x-text="r.ref_type"></span>' +
              '<span class="board-mention-label" x-text="r.label"></span>' +
              '<small x-text="r.sub"></small>' +
            '</button>' +
          '</template>' +
        '</div>' +
        '<div class="board-composer-toolbar">' +
          '<div class="board-color-picker">' +
            '<button type="button" ' +
              ':class="\'board-color-current color-\' + $store.board.composer.color" ' +
              'title="Color" aria-label="Color"></button>' +
            '<div class="board-color-options">' +
              '<template x-for="c in $store.board.colors" :key="c">' +
                '<button type="button" class="board-color-swatch" ' +
                  ':class="\'board-color-swatch-\' + c + ($store.board.composer.color === c ? \' selected\' : \'\')" ' +
                  ':title="c" ' +
                  '@click="$store.board.composer.color = c"></button>' +
              '</template>' +
            '</div>' +
          '</div>' +
          '<span class="board-composer-error" x-show="$store.board.composer.error" x-text="$store.board.composer.error"></span>' +
          // Sharing is purely @-mention driven: a plain note stays private,
          // but @Someone adds that user to board_card_refs and the note
          // shows up in their Mentions module. Hint at this in the corner.
          '<span class="board-composer-share-hint" ' +
            ':title="$store.board.composer.body.indexOf(\'@\') >= 0 ? \'This post-it will be shared with mentioned users.\' : \'Only you will see this. Type @ to share with someone.\'" ' +
            'x-text="$store.board.composer.body.indexOf(\'@\') >= 0 ? \'Shared\' : \'Private\'"></span>' +
        '</div>' +
      '</div>' +

      // Saved notes (private + shared + public-mentions) — below the
      // stack. The .is-pulled modifier applies a negative margin-top
      // so the list snugs up under the color-swatch stack; when the
      // composer is open instead of the stack, we drop the pull so
      // the composer card doesn\u2019t collide with the first saved note.
      '<div :class="\'board-notes-list\' + ($store.board.composer.open ? \'\' : \' is-pulled\')">' +
        '<template x-for="card in $store.board.allNotes" :key="card.id">' +
          // Wrapper holds the primary card + any "extra pages" when
          // a long body has been split. Classes drive the collapsed
          // stacked-paper look (single peeking edge) vs. expanded
          // stack of full cards. draggable=true is gated to private
          // notes only (your own notepad) so cross-user reorders
          // can\u2019t happen \u2014 see isDraggable() in board-sidebar.js.
          '<div :class="\'board-card-stack \' + ' +
            '($store.board.hasMorePages(card) ? \'board-card-stack-multi \' : \'\') + ' +
            '($store.board.isDraggable(card) ? \'is-draggable \' : \'\') + ' +
            '($store.board.drag.id === card.id ? \'is-dragging \' : \'\') + ' +
            '($store.board.drag.targetId === card.id ? (\'drag-over-\' + ($store.board.drag.mode || \'above\') + \' \') : \'\') + ' +
            '(card.__expanded ? \'is-expanded\' : \'is-collapsed\')" ' +
            // draggable is hardcoded to "true" (string literal) rather
            // than bound via :draggable \u2014 Alpine\u2019s reactive binding for
            // this attribute is unreliable across browsers. onDragStart
            // calls preventDefault() for cards the user shouldn\u2019t be
            // allowed to move (non-private, editing, etc.).
            'draggable="true" ' +
            '@dragstart="$store.board.onDragStart(card, $event)" ' +
            '@dragover="$store.board.onDragOver(card, $event)" ' +
            '@dragleave="$store.board.onDragLeave(card)" ' +
            '@drop="$store.board.onDrop(card, $event)" ' +
            '@dragend="$store.board.onDragEnd()">' +
          '<article :class="$store.board.cardClass(card)">' +

            // Pin + Copy + X delete on hover (opacity controlled by CSS).
            // Pin stays visible when active even on un-hover. All three
            // skipped while in edit mode to avoid competing affordances.
            '<button type="button" class="board-card-pin" ' +
              ':class="card.pinned ? \'is-pinned\' : \'\'" ' +
              'x-show="$store.board.editing.cardId !== card.id" ' +
              '@click.stop="$store.board.togglePin(card)" ' +
              ':title="card.pinned ? \'Unpin\' : \'Pin to top\'" ' +
              ':aria-label="card.pinned ? \'Unpin\' : \'Pin to top\'">\u{1F4CC}</button>' +
            '<button type="button" class="board-card-copy" ' +
              'x-show="$store.board.editing.cardId !== card.id" ' +
              '@click.stop="$store.board.copyCard(card)" ' +
              ':title="card.__copied ? \'Copied!\' : \'Copy text\'" ' +
              'aria-label="Copy text">' +
              '<span x-show="!card.__copied">\u29C9</span>' +
              '<span x-show="card.__copied" x-cloak>\u2713</span>' +
            '</button>' +
            '<button type="button" class="board-card-delete" ' +
              'x-show="$store.board.editing.cardId !== card.id" ' +
              '@click.stop="$store.board.archiveCard(card)" ' +
              'title="Delete" aria-label="Delete">\u00D7</button>' +

            '<template x-if="$store.board.editing.cardId === card.id">' +
              '<div class="board-card-editing">' +
                '<textarea :id="\'board-edit-textarea-\' + card.id" ' +
                  'class="board-card-edit-textarea" rows="2" ' +
                  ':value="$store.board.editing.body" ' +
                  '@input="$store.board.onBodyInput(\'editing\', $event.target)" ' +
                  '@keydown="$store.board.onBodyKeydown(\'editing\', $event.target, $event)"></textarea>' +
                '<div class="board-mention-popup" ' +
                  'x-show="$store.board.mention.active && $store.board.mention.for === \'editing\' && $store.board.mention.results.length" x-cloak>' +
                  '<template x-for="(r, i) in $store.board.mention.results" :key="r.ref_type + r.ref_id">' +
                    '<button type="button" class="board-mention-opt" ' +
                      ':class="{ active: i === $store.board.mention.selectedIndex }" ' +
                      '@click="$store.board.pickMention(r, document.getElementById(\'board-edit-textarea-\' + card.id))">' +
                      '<span class="board-mention-type" x-text="r.ref_type"></span>' +
                      '<span class="board-mention-label" x-text="r.label"></span>' +
                      '<small x-text="r.sub"></small>' +
                    '</button>' +
                  '</template>' +
                '</div>' +
                '<div class="board-composer-toolbar">' +
                  '<div class="board-color-picker">' +
                    '<button type="button" ' +
                      ':class="\'board-color-current color-\' + $store.board.editing.color" ' +
                      'title="Color" aria-label="Color"></button>' +
                    '<div class="board-color-options">' +
                      '<template x-for="c in $store.board.colors" :key="c">' +
                        '<button type="button" class="board-color-swatch" ' +
                          ':class="\'board-color-swatch-\' + c + ($store.board.editing.color === c ? \' selected\' : \'\')" ' +
                          '@click="$store.board.editing.color = c"></button>' +
                      '</template>' +
                    '</div>' +
                  '</div>' +
                  '<span class="board-composer-error" x-show="$store.board.editing.error" x-text="$store.board.editing.error"></span>' +
                  '<span class="board-composer-share-hint" ' +
                    ':title="$store.board.editing.body.indexOf(\'@\') >= 0 ? \'This post-it is shared with mentioned users.\' : \'Only you will see this. Type @ to share with someone.\'" ' +
                    'x-text="$store.board.editing.body.indexOf(\'@\') >= 0 ? \'Shared\' : \'Private\'"></span>' +
                '</div>' +
              '</div>' +
            '</template>' +

            '<template x-if="$store.board.editing.cardId !== card.id">' +
              '<div class="board-card-body" ' +
                'x-html="$store.board.renderBody($store.board.firstPage(card))" ' +
                '@click="$store.board.startEdit(card)"></div>' +
            '</template>' +

            // "+N more" / "Hide pages" toggle \u2014 only appears when the
            // body has been split into 2+ pages and we\u2019re not in edit
            // mode. Sits in the bottom-right corner of the first card.
            '<button type="button" class="board-card-pages-toggle" ' +
              'x-show="$store.board.hasMorePages(card) && $store.board.editing.cardId !== card.id" ' +
              '@click.stop="$store.board.toggleExpand(card)" ' +
              'x-text="card.__expanded ? \'Hide pages\' : (\'+\' + ($store.board.cardPages(card).length - 1) + \' more\')"></button>' +

          '</article>' +

          // Extra pages \u2014 only rendered when expanded. Each is a full
          // card sharing the same color/tilt-from-id seed so the
          // stack reads as one note. Click any extra page to enter
          // edit mode on the parent card.
          '<template x-if="$store.board.hasMorePages(card) && card.__expanded && $store.board.editing.cardId !== card.id">' +
            '<template x-for="(p, i) in $store.board.extraPages(card)" :key="i">' +
              '<article :class="$store.board.cardClass(card) + \' board-card-page-extra\'">' +
                '<div class="board-card-body" ' +
                  'x-html="$store.board.renderBody(p)" ' +
                  '@click="$store.board.startEdit(card)"></div>' +
              '</article>' +
            '</template>' +
          '</template>' +

          '</div>' + // /.board-card-stack
        '</template>' +
      '</div>' +

    '</section>' +

  '</aside>' +
  '</div>' // /.board-root-right
);

const BOARD_LEFT_MARKUP = (
  '<div class="board-root board-root-left" x-data x-cloak>' +
    '<aside class="board-sidebar board-sidebar-left" ' +
      'x-show="$store.board && !$store.board.isCollapsed" ' +
      'aria-label="Messages sidebar">' +

      '<h3 class="board-zone-heading">Message Everyone</h3>' +

      // Always-open composer at the top \u2014 sits exactly where the
      // next new message will land. Type, hit Enter to send,
      // Shift+Enter for newline, Escape to clear. @user mention directs
      // the message; no mentions \u2192 broadcast to everyone.
      '<div class="board-message-composer">' +
        '<textarea id="board-message-textarea" class="board-message-textarea" ' +
          'rows="1" placeholder="Type a message\u2026 (@ to address someone)" ' +
          ':value="$store.board.messageComposer.body" ' +
          '@input="$store.board.onBodyInput(\'messageComposer\', $event.target)" ' +
          '@keydown="$store.board.onBodyKeydown(\'messageComposer\', $event.target, $event)"></textarea>' +
        '<div class="board-mention-popup" ' +
          'x-show="$store.board.mention.active && $store.board.mention.for === \'messageComposer\' && $store.board.mention.results.length" x-cloak>' +
          '<template x-for="(r, i) in $store.board.mention.results" :key="r.ref_type + r.ref_id">' +
            '<button type="button" class="board-mention-opt" ' +
              ':class="{ active: i === $store.board.mention.selectedIndex }" ' +
              '@click="$store.board.pickMention(r, document.getElementById(\'board-message-textarea\'))">' +
              '<span class="board-mention-type" x-text="r.ref_type"></span>' +
              '<span class="board-mention-label" x-text="r.label"></span>' +
            '</button>' +
          '</template>' +
        '</div>' +
        '<div class="board-message-error" x-show="$store.board.messageComposer.error" ' +
          'x-text="$store.board.messageComposer.error"></div>' +
      '</div>' +

      // Scrollable message list (chat thread, newest \u2192 oldest).
      // Sits below the composer so each new send lands right against it.
      '<div class="board-message-list" x-ref="msgList">' +
        '<template x-if="$store.board.messages.length === 0">' +
          '<p class="board-zone-empty">No messages yet \u2014 say hi.</p>' +
        '</template>' +
        '<template x-for="msg in $store.board.messages" :key="msg.id">' +
          '<div :class="\'board-message board-message-\' + (msg.from_me ? \'out\' : \'in\') + (msg.flag === \'red\' ? \' is-emphasized\' : \'\')">' +
            // Emphasize \u2605 + delete \u00D7 \u2014 author-only, on hover.
            // Emphasize stays visible at rest when active so the
            // recipient can see at a glance which messages were
            // marked important by their author.
            '<button type="button" class="board-message-emphasize" ' +
              ':class="msg.flag === \'red\' ? \'is-on\' : \'\'" ' +
              'x-show="msg.from_me" ' +
              '@click.stop="$store.board.toggleEmphasize(msg)" ' +
              ':title="msg.flag === \'red\' ? \'Remove emphasis\' : \'Emphasize\'" ' +
              ':aria-label="msg.flag === \'red\' ? \'Remove emphasis\' : \'Emphasize\'">\u2605</button>' +
            '<button type="button" class="board-message-delete" ' +
              'x-show="msg.from_me" ' +
              '@click.stop="$store.board.deleteMessage(msg)" ' +
              'title="Delete message" aria-label="Delete message">\u00D7</button>' +
            '<span class="board-message-prefix" x-text="$store.board.messagePrefix(msg) + \'-\'"></span>' +
            '<span class="board-message-body" x-html="$store.board.renderBody(msg.body)"></span>' +
          '</div>' +
        '</template>' +
      '</div>' +

    '</aside>' +
  '</div>'
);

// (The display-preferences gear popup previously lived here. The three
// toggles were moved to the /settings page so there's a single obvious
// place for all user preferences. window.Pipeline.userPrefs is still
// populated via displayPrefsBootScript further down so client code can
// branch on the current user's prefs without a server round-trip.)

// Header restore button \u2014 sits in .header-right, just left of the
// notification bell. Only visible when the board has been hidden via
// the X (or any other reason `isCollapsed` is true). Clicking it
// expands both sidebars in one shot.
const BOARD_RESTORE_HEADER_BTN = (
  '<button type="button" class="board-restore-btn" x-data x-cloak ' +
    'x-show="$store.board && $store.board.isCollapsed" ' +
    '@click="$store.board.expandNow()" ' +
    'aria-label="Open board" title="Open board">' +
    '<svg class="board-restore-icon" viewBox="0 0 24 24" width="20" height="20" ' +
      'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' +
      // Sticky-note silhouette with a corner fold.
      '<path d="M4 4h12l4 4v12H4z"/>' +
      '<path d="M16 4v4h4"/>' +
    '</svg>' +
    '<span class="board-restore-badge" ' +
      'x-show="$store.board && $store.board.collapsedBadge > 0" ' +
      'x-text="$store.board && $store.board.collapsedBadge"></span>' +
  '</button>'
);

// (Previously the sidebar overlaid the page and required body-class
// gymnastics to push main-content padding. Sidebars now sit in the
// natural left/right margin of the centered .site-main, so no body
// class is needed — they just appear or disappear via @media.)

/**
 * Full-page HTML shell: includes nav, user badge, and slot for body.
 * Vendored HTMX + Alpine from /js so Access + CSP don't fight CDN cross-origin.
 *
 * opts.breadcrumbs — optional array of { label, href? } for the breadcrumb trail.
 */
export function layout(title, body, opts = {}) {
  const { user, flash, activeNav, breadcrumbs } = opts;
  const pageTitle = title ? `${escape(title)} — C-LARS Pipeline` : 'C-LARS Pipeline';
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
  <script>
    // One-time localStorage migration: rename legacy "pms.*" keys to
    // "pipeline.*" so existing user prefs (column widths, sort orders,
    // account-picker grouping) survive the rebrand. Runs synchronously
    // before any deferred script reads localStorage.
    (function () {
      try {
        if (localStorage.getItem('pipeline.__migrated')) return;
        for (var i = localStorage.length - 1; i >= 0; i--) {
          var k = localStorage.key(i);
          if (k && k.indexOf('pms.') === 0) {
            var newKey = 'pipeline.' + k.slice(4);
            if (localStorage.getItem(newKey) === null) {
              localStorage.setItem(newKey, localStorage.getItem(k));
            }
            localStorage.removeItem(k);
          }
        }
        localStorage.setItem('pipeline.__migrated', '1');
      } catch (_) { /* private mode etc. — ignore */ }
    })();
  </script>
  <link rel="icon" type="image/svg+xml" href="/img/logo.svg">
  <link rel="icon" type="image/png" sizes="120x120" href="/img/logo-120.png">
  <link rel="stylesheet" href="/css/pipeline.css">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Caveat:wght@400;600;700&family=Kalam:wght@300;400;700&display=swap" rel="stylesheet">
  <script defer src="/js/htmx.min.js"></script>
  <!-- wizard-modal.js (engine) + per-wizard configs MUST load before
       alpine.min.js. Alpine 3's bundle auto-calls Alpine.start() as
       soon as it parses, which fires 'alpine:init' synchronously. Any
       listener added after that is too late and the store never
       registers. Defer preserves source-order execution. -->
  <script defer src="/js/wizard-modal.js"></script>
  <script defer src="/js/wizards/task.js"></script>
  <script defer src="/js/wizards/account.js"></script>
  <script defer src="/js/wizards/contact.js"></script>
  <script defer src="/js/wizards/opportunity.js"></script>
  <script defer src="/js/wizards/quote.js"></script>
  <script defer src="/js/wizards/job.js"></script>
  ${user ? '<script defer src="/js/board-sidebar.js"></script>' : ''}
  <script defer src="/js/alpine.min.js"></script>
  <script defer src="/js/live-calc.js"></script>
  <script defer src="/js/account-picker.js"></script>
  <script defer src="/js/table-resize.js"></script>
  ${opts.charts ? '<script defer src="/js/chart.min.js"></script>' : ''}
</head>
<body>
  <header class="site-header">
    <div class="brand">
      <a href="/"><img src="/img/logo-120.png" alt="C-LARS" class="brand-logo"><strong>Pipeline</strong></a>
    </div>
    <button type="button" class="nav-toggle" aria-label="Open navigation menu" aria-expanded="false" aria-controls="site-nav">
      <svg class="nav-toggle-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <line x1="4" y1="7"  x2="20" y2="7"  stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <line x1="4" y1="12" x2="20" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        <line x1="4" y1="17" x2="20" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
    </button>
    <nav class="site-nav" id="site-nav">
      ${navLink('/accounts', 'Accounts', activeNav)}
      ${navLink('/opportunities', 'Opportunities', activeNav)}
      ${navLink('/quotes', 'Quotes', activeNav)}
      ${navLink('/activities', 'Tasks', activeNav)}
      ${navLink('/documents/library', 'Documents', activeNav)}
      ${navLink('/library', 'Library', activeNav)}
      ${navLink('/reports', 'Reports', activeNav)}
      ${navLink('/jobs', 'Jobs', activeNav)}
      ${navLink('/workflow', 'Workflow', activeNav)}
      ${navLink('/settings', 'Settings', activeNav)}
      ${user && user.email === 'wes.yoakum@c-lars.com' ? navLink('/ai-inbox', 'AI Inbox', activeNav) : ''}
    </nav>
    <div class="header-right">
      ${user ? BOARD_RESTORE_HEADER_BTN : ''}
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
  ${WIZARD_MODAL_MARKUP}
  ${BLOCKER_MODAL_MARKUP}
  ${user._sitePrefs?.messaging_enabled ? BOARD_LEFT_MARKUP : ''}
  ${BOARD_RIGHT_MARKUP}` : ''}
  ${flash ? `<div class="flash flash-${escape(flash.kind ?? 'info')}">${escape(flash.message)}</div>` : ''}
  ${user ? `<script>${displayPrefsBootScript(user)}</script>` : ''}
  <main class="site-main">
${breadcrumbHtml}
${body}
  </main>
  <footer class="site-footer">
    <small>C-LARS Pipeline Management System</small>
  </footer>
  ${versionTag ? `<div class="version-badge">${versionTag}</div>` : ''}
  <button type="button" class="back-to-top" aria-label="Back to top" data-visible="0">
    <svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 14 12 8 18 14"/></svg>
  </button>
  <script>${BACK_TO_TOP_SCRIPT}</script>
  <script>${NAV_TOGGLE_SCRIPT}</script>
  ${user ? `<script>${NOTIFICATION_STORE_SCRIPT}</script>` : ''}
  ${user ? `<script>${BLOCKER_MODAL_STORE_SCRIPT}</script>` : ''}
</body>
</html>`;
}

// Inline boot script for the display-prefs gear popup. Registers the
// Alpine.data factory and exposes the current user's prefs to client
// code (account-picker.js, wizards) via window.Pipeline.userPrefs so they
// can branch on show_alias / group_rollup without a server round-trip.
function displayPrefsBootScript(user) {
  // Exposes the current user's display preferences on
  // window.Pipeline.userPrefs so client code (account-picker.js, wizards,
  // list helpers) can branch on them without a server round-trip.
  //
  // The toggles themselves live on the /settings page; this boot
  // script just populates the globals at page load.
  const showAlias = user && user.show_alias ? 1 : 0;
  const groupRollup = user && user.group_rollup ? 1 : 0;
  const activeOnly = user && user.active_only ? 1 : 0;
  // list_table_prefs is a JSON blob keyed by list-table storageKey.
  // When present, listScript() uses it as a first-load seed for pages
  // where localStorage has no entry yet. See migration 0039.
  let listPrefsJson = 'null';
  if (user && user.list_table_prefs) {
    try {
      // Validate + normalize: parse then re-stringify so we never
      // inject raw user content into the script tag unchecked.
      const parsed = JSON.parse(user.list_table_prefs);
      listPrefsJson = JSON.stringify(parsed).replace(/</g, '\\u003c');
    } catch (_) {
      listPrefsJson = 'null';
    }
  }
  return (
    "window.Pipeline = window.Pipeline || {};\n" +
    "window.Pipeline.userPrefs = { show_alias: " + showAlias +
      ", group_rollup: " + groupRollup +
      ", active_only: " + activeOnly + " };\n" +
    "window.Pipeline.listTableSiteDefaults = " + listPrefsJson + ";\n"
  );
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
