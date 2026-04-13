// functions/library/items/index.js
//
// GET  /library/items        — list + inline-add form
// POST /library/items        — create a new library item
//
// Items library is a global catalog of products and services available
// for quoting. Each item has a name, description, default unit, default
// price, and an optional category. Items can be deactivated without
// deleting them.

import { all, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { layout, htmlResponse, html, escape } from '../../lib/layout.js';
import { uuid, now } from '../../lib/ids.js';
import { redirectWithFlash, formBody, readFlash } from '../../lib/http.js';
import { fmtDollar } from '../../lib/pricing.js';

export async function onRequestGet(context) {
  return renderList(context, {});
}

/**
 * Render the items list + add form. Extracted so POST handlers can
 * re-render in place when validation fails.
 */
export async function renderList(context, { values = {}, errors = {} } = {}) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);

  const rows = await all(
    env.DB,
    `SELECT id, name, description, category, default_unit, default_price, active, updated_at
       FROM items_library
      ORDER BY active DESC, name`
  );

  const errText = (k) => (errors[k] ? html`<small class="error">${errors[k]}</small>` : '');

  const body = html`
    <section class="card">
      <div class="card-header">
        <h1>Items Library</h1>
        <a class="btn" href="/library">← Library</a>
      </div>

      <p class="muted">
        Catalog of products and services available for quoting. Items can
        be referenced from quote line items.
      </p>

      ${rows.length === 0
        ? html`<p class="muted">No items yet.</p>`
        : html`
          <table class="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Description</th>
                <th>Category</th>
                <th>Unit</th>
                <th class="num">Default Price</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((r) => html`
                <tr${r.active ? '' : ' class="inactive"'}>
                  <td><a href="/library/items/${escape(r.id)}">${escape(r.name)}</a></td>
                  <td>${escape(r.description ?? '')}</td>
                  <td>${escape(r.category ?? '')}</td>
                  <td>${escape(r.default_unit ?? 'ea')}</td>
                  <td class="num">${fmtDollar(r.default_price)}</td>
                  <td>${r.active ? 'Active' : html`<span class="muted">Inactive</span>`}</td>
                  <td class="row-actions">
                    <a class="btn small" href="/library/items/${escape(r.id)}">Edit</a>
                  </td>
                </tr>
              `)}
            </tbody>
            <tfoot>
              <tr>
                <th colspan="7">${rows.length} item${rows.length === 1 ? '' : 's'}</th>
              </tr>
            </tfoot>
          </table>
        `}

      <h2 class="section-h">Add item</h2>
      <form method="post" action="/library/items" class="inline-form">
        <div class="field">
          <label>Name</label>
          <input type="text" name="name" value="${values.name ?? ''}"
                 required autofocus>
          ${errText('name')}
        </div>
        <div class="field">
          <label>Description</label>
          <input type="text" name="description" value="${values.description ?? ''}">
        </div>
        <div class="field">
          <label>Category</label>
          <input type="text" name="category" value="${values.category ?? ''}">
        </div>
        <div class="field">
          <label>Unit</label>
          <input type="text" name="default_unit" value="${values.default_unit ?? 'ea'}"
                 placeholder="ea">
        </div>
        <div class="field">
          <label>Default Price</label>
          <input type="text" name="default_price" value="${values.default_price ?? ''}"
                 placeholder="0.00">
          ${errText('default_price')}
        </div>
        <button class="btn primary" type="submit">Add item</button>
      </form>
    </section>
  `;

  return htmlResponse(
    layout('Items Library', body, {
      user,
      env: data?.env,
      activeNav: '/library',
      flash: readFlash(url),
    })
  );
}

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const input = await formBody(request);

  const errors = {};
  const name = (input.name ?? '').trim();
  if (!name) errors.name = 'Name is required.';

  const defaultPrice = input.default_price ? parseFloat(input.default_price) : 0;
  if (input.default_price && isNaN(defaultPrice)) {
    errors.default_price = 'Default price must be a number.';
  }

  if (Object.keys(errors).length) {
    return renderList(context, { values: input, errors });
  }

  const id = uuid();
  const ts = now();
  const description = (input.description ?? '').trim() || null;
  const category = (input.category ?? '').trim() || null;
  const defaultUnit = (input.default_unit ?? '').trim() || 'ea';

  await batch(env.DB, [
    stmt(
      env.DB,
      `INSERT INTO items_library (id, name, description, default_unit, default_price, category, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [id, name, description, defaultUnit, defaultPrice, category, ts, ts]
    ),
    auditStmt(env.DB, {
      entityType: 'items_library',
      entityId: id,
      eventType: 'created',
      user,
      summary: `Created library item "${name}"`,
      changes: { name, description, defaultUnit, defaultPrice, category },
    }),
  ]);

  return redirectWithFlash('/library/items', `Added "${name}".`);
}
