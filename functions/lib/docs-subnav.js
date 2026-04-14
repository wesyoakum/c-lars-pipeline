// functions/lib/docs-subnav.js
//
// Sub-navigation bar for the Documents section — shared between
// the Documents Library and Templates pages.

import { html } from './layout.js';

/**
 * Render the Documents sub-nav with "Documents" and "Templates" tabs.
 * @param {'library'|'templates'} active — which tab is active
 */
export function docsSubNav(active) {
  return html`
    <nav class="card" style="padding:0.5rem 1rem; display:flex; align-items:center; gap:1rem; flex-wrap:wrap; margin-bottom:0;">
      <a class="nav-link ${active === 'library' ? 'active' : ''}"
         href="/documents/library">Documents</a>
      <a class="nav-link ${active === 'templates' ? 'active' : ''}"
         href="/documents/templates">Templates</a>
    </nav>`;
}
