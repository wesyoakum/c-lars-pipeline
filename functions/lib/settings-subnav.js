// functions/lib/settings-subnav.js
//
// Sub-navigation bar for the Settings section — shared between every
// /settings/* page. Mirrors library-subnav.js so /settings reads the
// same way as /library.
//
// As the Settings area grew (currently 10 sub-pages, more coming as
// the Katana / WFM integrations expand), the flat tab strip became
// unwieldy. Now consolidated into 5 top-level entries; two of them
// open hover-and-focus dropdowns.
//
// Adding a new sub-page:
//   1. Pick a group (or add a new top-level entry to GROUPS).
//   2. Add { key, label, href } to that group's items array.
//   3. In the new page's body, call settingsSubNav('<your-key>', isAdmin).
//
// The 'active' parameter is a key string. Top-level links match
// exactly; dropdowns highlight when ANY of their items match.

import { html } from './layout.js';

/**
 * Top-level groups, in render order. Each entry is either:
 *   { type: 'link', key, label, href, adminOnly }
 *   { type: 'dropdown', label, adminOnly, items: [{ key, label, href }] }
 *
 * Non-admin users only see entries with adminOnly === false. Inside a
 * dropdown, every item inherits the parent's adminOnly flag — there's
 * no per-item gating today (every item under an admin dropdown is
 * itself admin-only).
 */
const GROUPS = [
  { type: 'link', key: 'preferences',   label: 'Preferences',    href: '/settings',                adminOnly: false },
  { type: 'link', key: 'notifications', label: 'Notifications',  href: '/settings/notifications',  adminOnly: false },
  { type: 'link', key: 'users',         label: 'Users',          href: '/settings/users',          adminOnly: true  },
  {
    type: 'dropdown', label: 'Integrations', adminOnly: true,
    items: [
      { key: 'wfm-import',          label: 'WFM import',       href: '/settings/wfm-import' },
      { key: 'katana-probe',        label: 'Katana probe',     href: '/settings/katana-probe' },
      { key: 'katana-customer-map', label: 'Katana customers', href: '/settings/katana-customer-map' },
    ],
  },
  {
    type: 'dropdown', label: 'Admin tools', adminOnly: true,
    items: [
      { key: 'auto-tasks',   label: 'Auto-Task Rules', href: '/settings/auto-tasks' },
      { key: 'fake-names',   label: 'Fake names',      href: '/settings/fake-names' },
      { key: 'history',      label: 'History',         href: '/settings/history' },
      { key: 'data-refresh', label: 'Data refresh',    href: '/settings/data-refresh' },
    ],
  },
];

/**
 * Render the Settings sub-nav.
 * @param {string} active   — current page key (see GROUPS for valid values)
 * @param {boolean} isAdmin — include admin-only entries when true
 */
export function settingsSubNav(active, isAdmin) {
  const visible = GROUPS.filter((g) => isAdmin || !g.adminOnly);

  const rendered = visible.map((g) => {
    if (g.type === 'link') {
      const isActive = active === g.key;
      return html`<a class="nav-link ${isActive ? 'active' : ''}" href="${g.href}">${g.label}</a>`;
    }
    // dropdown
    const isActive = g.items.some((i) => i.key === active);
    return html`
      <div class="nav-dropdown">
        <button type="button" class="nav-link nav-dropdown-trigger ${isActive ? 'active' : ''}" aria-haspopup="true">
          ${g.label} <span class="nav-dropdown-caret" aria-hidden="true">&#9662;</span>
        </button>
        <div class="nav-dropdown-menu" role="menu">
          ${g.items.map((i) => html`
            <a class="nav-link ${active === i.key ? 'active' : ''}" href="${i.href}" role="menuitem">${i.label}</a>
          `)}
        </div>
      </div>
    `;
  });

  return html`<nav class="card settings-subnav">${rendered}</nav>`;
}
