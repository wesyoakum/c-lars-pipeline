// functions/lib/library-subnav.js
//
// Sub-navigation bar for the Library section — shared between the
// Direct Material, Direct Labor, Line Items, and Price Builds pages.
// Mirrors docs-subnav.js so /library and /documents read the same way.

import { html } from './layout.js';

/**
 * Render the Library sub-nav.
 * @param {'dm-items'|'labor-items'|'items'|'builds'} active — which tab is active
 */
export function librarySubNav(active) {
  return html`
    <nav class="card" style="padding:0.5rem 1rem; display:flex; align-items:center; gap:1rem; flex-wrap:wrap; margin-bottom:0;">
      <a class="nav-link ${active === 'dm-items' ? 'active' : ''}"
         href="/library/dm-items">Direct Material</a>
      <a class="nav-link ${active === 'labor-items' ? 'active' : ''}"
         href="/library/labor-items">Direct Labor</a>
      <a class="nav-link ${active === 'items' ? 'active' : ''}"
         href="/library/items">Line Items</a>
      <a class="nav-link ${active === 'builds' ? 'active' : ''}"
         href="/library/builds">Price Builds</a>
    </nav>`;
}
