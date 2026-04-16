// functions/library/items/index.js
//
// GET  /library/items        — list + inline-add form
// POST /library/items        — create a new library item

import { all, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { layout, htmlResponse, html, raw, escape } from '../../lib/layout.js';
import { uuid, now } from '../../lib/ids.js';
import { redirectWithFlash, formBody, readFlash } from '../../lib/http.js';
import { fmtDollar } from '../../lib/pricing.js';
import { listScript, listTableHead, listToolbar, rowDataAttrs } from '../../lib/list-table.js';
import { listBulkEditScript } from '../../lib/list-bulk-edit.js';

export async function onRequestGet(context) {
  return renderList(context, {});
}

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

  const columns = [
    { key: 'name',          label: 'Name',          sort: 'text',   filter: 'text',   default: true },
    { key: 'description',   label: 'Description',   sort: 'text',   filter: 'text',   default: true },
    { key: 'category',      label: 'Category',      sort: 'text',   filter: 'select', default: true },
    { key: 'default_unit',  label: 'Unit',           sort: 'text',   filter: 'text',   default: true },
    { key: 'default_price', label: 'Default Price',  sort: 'number', filter: 'range',  default: true },
    { key: 'status',        label: 'Status',         sort: 'text',   filter: 'select', default: true },
  ];

  const rowData = rows.map(r => ({
    id: r.id,
    name: r.name ?? '',
    description: r.description ?? '',
    category: r.category ?? '',
    default_unit: r.default_unit ?? 'ea',
    default_price: r.default_price != null ? Number(r.default_price) : 0,
    default_price_display: fmtDollar(r.default_price),
    status: r.active ? 'Active' : 'Inactive',
    active: r.active,
    updated: (r.updated_at ?? '').slice(0, 10),
  }));

  const errText = (k) => (errors[k] ? html`<small class="error">${errors[k]}</small>` : '');

  const body = html`
    <section class="card">
      <div class="card-header">
        <h1>Line Items Library</h1>
        <div style="display:flex;align-items:center;gap:0.5rem">
          ${listToolbar({ id: 'items', count: rows.length, columns, bulk: true })}
          <a class="btn" href="/library">\u2190 Library</a>
        </div>
      </div>

      <p class="muted">
        All the info that appears within a line item on a quote \u2014 part
        numbers, descriptions, units, default prices.
      </p>

      ${rows.length === 0
        ? html`<p class="muted">No items yet.</p>`
        : html`
          <div class="opp-list" data-columns="${escape(JSON.stringify(columns))}">
            <table class="data opp-list-table">
              ${listTableHead(columns, rowData)}
              <tbody data-role="rows">
                ${rowData.map(r => html`
                  <tr data-row-id="${escape(r.id)}"
                      ${raw(rowDataAttrs(columns, r))}
                      ${!r.active ? 'class="inactive"' : ''}>
                    <td class="col-name" data-col="name"><a href="/library/items/${escape(r.id)}">${escape(r.name)}</a></td>
                    <td class="col-description" data-col="description">${escape(r.description)}</td>
                    <td class="col-category" data-col="category">${escape(r.category)}</td>
                    <td class="col-default_unit" data-col="default_unit">${escape(r.default_unit)}</td>
                    <td class="col-default_price num" data-col="default_price">${escape(r.default_price_display)}</td>
                    <td class="col-status" data-col="status">${r.active ? 'Active' : html`<span class="muted">Inactive</span>`}</td>
                  </tr>
                `)}
              </tbody>
              <tfoot>
                <tr><th colspan="6">${rows.length} item${rows.length === 1 ? '' : 's'}</th></tr>
              </tfoot>
            </table>
          </div>
          <script>${raw(listScript('pms.libItems.v1', 'name', 'asc'))}</script>
          <script>${raw(listBulkEditScript({
            patchUrl: '/library/items/:id/patch',
            deleteUrl: '/library/items/:id/delete',
          }))}</script>
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
    layout('Line Items Library', body, {
      user,
      env: data?.env,
      activeNav: '/library',
      flash: readFlash(url),
      breadcrumbs: [
        { label: 'Library', href: '/library' },
        { label: 'Line Items' },
      ],
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
