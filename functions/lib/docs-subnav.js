// functions/lib/docs-subnav.js
//
// Sub-navigation bar for the Documents section — shared between
// the Attachments, Templates, and Resources pages.

import { html } from './layout.js';

/**
 * Render the Documents sub-nav with "Attachments", "Templates",
 * "Filenames", and "Resources" tabs.
 * @param {'library'|'templates'|'filenames'|'resources'} active — which tab is active
 */
export function docsSubNav(active) {
  return html`
    <nav class="card" style="padding:0.5rem 1rem; display:flex; align-items:center; gap:1rem; flex-wrap:wrap; margin-bottom:0;">
      <a class="nav-link ${active === 'library' ? 'active' : ''}"
         href="/documents/library">Attachments</a>
      <a class="nav-link ${active === 'templates' ? 'active' : ''}"
         href="/documents/templates">Templates</a>
      <a class="nav-link ${active === 'filenames' ? 'active' : ''}"
         href="/documents/filenames">Filenames</a>
      <a class="nav-link ${active === 'resources' ? 'active' : ''}"
         href="/documents/resources">Resources</a>
    </nav>`;
}
