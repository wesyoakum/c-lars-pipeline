// functions/library/index.js
//
// GET /library — landing page for the shared cost libraries.
//
// The Direct Material and Labor libraries are global (all users see
// the same items) and feed cost builds via opt-in linkage toggles.
// This page gives each library its own entry point, plus headline
// counts so Wes can see at a glance what's in the catalog.

import { one } from '../lib/db.js';
import { layout, htmlResponse, html } from '../lib/layout.js';
import { readFlash } from '../lib/http.js';

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);

  const dmCount = await one(env.DB, 'SELECT COUNT(*) AS n FROM dm_items');
  const laborCount = await one(env.DB, 'SELECT COUNT(*) AS n FROM labor_items');
  const itemsCount = await one(env.DB, 'SELECT COUNT(*) AS n FROM items_library WHERE active = 1');
  const buildsCount = await one(env.DB, 'SELECT COUNT(*) AS n FROM builds_library WHERE active = 1');

  const body = html`
    <section class="card">
      <div class="card-header">
        <h1>Library</h1>
      </div>
      <p class="muted">
        Shared cost libraries feed Opportunity cost builds via opt-in
        toggles. Changes here apply globally — every user sees the same
        items.
      </p>

      <div class="library-grid">
        <a class="library-card" href="/library/dm-items">
          <h2>Direct Material</h2>
          <p class="muted">Products, spares kits, and assemblies with a fixed DM cost.</p>
          <p class="library-count"><strong>${dmCount?.n ?? 0}</strong> items</p>
        </a>
        <a class="library-card" href="/library/labor-items">
          <h2>Labor</h2>
          <p class="muted">Reusable labor packages broken out by workcenter (hours × rate).</p>
          <p class="library-count"><strong>${laborCount?.n ?? 0}</strong> items</p>
        </a>
        <a class="library-card" href="/library/items">
          <h2>Items</h2>
          <p class="muted">Catalog of products and services available for quoting.</p>
          <p class="library-count"><strong>${itemsCount?.n ?? 0}</strong> items</p>
        </a>
        <a class="library-card" href="/library/builds">
          <h2>Builds</h2>
          <p class="muted">Reusable price build templates with DM/DL/IMOH/Other cost structures.</p>
          <p class="library-count"><strong>${buildsCount?.n ?? 0}</strong> templates</p>
        </a>
      </div>
    </section>
  `;

  return htmlResponse(
    layout('Library', body, {
      user,
      env: data?.env,
      activeNav: '/library',
      flash: readFlash(url),
    })
  );
}
