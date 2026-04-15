// functions/lib/docs-subnav.js
//
// Sub-navigation bar for the Documents section — shared between
// the Attachments, Templates, and Resources pages.
//
// The former "Filenames" tab was folded into the Templates tab as an
// inline-editable column so each template carries its own filename
// convention. /documents/filenames now redirects there.

import { html } from './layout.js';

/**
 * Render the Documents sub-nav with "Attachments", "Templates",
 * and "Resources" tabs.
 * @param {'library'|'templates'|'resources'} active — which tab is active
 */
export function docsSubNav(active) {
  return html`
    <nav class="card" style="padding:0.5rem 1rem; display:flex; align-items:center; gap:1rem; flex-wrap:wrap; margin-bottom:0;">
      <a class="nav-link ${active === 'library' ? 'active' : ''}"
         href="/documents/library">Attachments</a>
      <a class="nav-link ${active === 'templates' ? 'active' : ''}"
         href="/documents/templates">Templates</a>
      <a class="nav-link ${active === 'resources' ? 'active' : ''}"
         href="/documents/resources">Resources</a>
    </nav>`;
}
