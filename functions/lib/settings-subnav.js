// functions/lib/settings-subnav.js
//
// Sub-navigation bar for the Settings section — shared between the
// Preferences, Auto-Task Rules, and Users pages. Mirrors
// library-subnav.js so /settings reads the same way as /library.
//
// Admin-only tabs are hidden from non-admin users; those users just
// see the Preferences tab.

import { html } from './layout.js';

/**
 * Render the Settings sub-nav.
 * @param {'preferences'|'notifications'|'auto-tasks'|'users'|'history'|'fake-names'} active — which tab is active
 * @param {boolean} isAdmin — include admin-only tabs when true
 */
export function settingsSubNav(active, isAdmin) {
  return html`
    <nav class="card" style="padding:0.5rem 1rem; display:flex; align-items:center; gap:1rem; flex-wrap:wrap; margin-bottom:0;">
      <a class="nav-link ${active === 'preferences' ? 'active' : ''}"
         href="/settings">Preferences</a>
      <a class="nav-link ${active === 'notifications' ? 'active' : ''}"
         href="/settings/notifications">Notifications</a>
      ${isAdmin ? html`
        <a class="nav-link ${active === 'auto-tasks' ? 'active' : ''}"
           href="/settings/auto-tasks">Auto-Task Rules</a>
        <a class="nav-link ${active === 'fake-names' ? 'active' : ''}"
           href="/settings/fake-names">Fake names</a>
        <a class="nav-link ${active === 'users' ? 'active' : ''}"
           href="/settings/users">Users</a>
        <a class="nav-link ${active === 'history' ? 'active' : ''}"
           href="/settings/history">History</a>
      ` : ''}
    </nav>`;
}
