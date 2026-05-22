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
import { ieText, ieSelect, listInlineEditScript } from '../../lib/list-inline-edit.js';
import { librarySubNav } from '../../lib/library-subnav.js';
import { hasRole } from '../../lib/auth.js';
import { syncKatana } from '../../api/katana-sync.js';

export async function onRequestGet(context) {
  // Background-sync Katana products
  context.waitUntil(syncKatana(context.env).catch(() => {}));
  return renderList(context, {});
}

export async function renderList(context, { values = {}, errors = {} } = {}) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);

  const rows = await all(
    env.DB,
    `SELECT id, name, part_number, description, category, item_type,
            default_unit, default_price, default_cost,
            use_count, last_used_at, item_notes, active, updated_at, source
       FROM items_library
      WHERE deleted_at IS NULL
      ORDER BY active DESC, use_count DESC, name`
  );

  const TYPE_LABELS = { product: 'Product', service: 'Service', labor: 'Labor', misc: 'Misc' };
  const SOURCE_LABELS = { manual: 'Manual', mrpeasy: 'MRPeasy', katana: 'Katana' };

  const columns = [
    { key: 'part_number',   label: 'Part #',         sort: 'text',   filter: 'text',   default: true },
    { key: 'name',          label: 'Name',           sort: 'text',   filter: 'text',   default: true },
    { key: 'item_type_label', label: 'Type',         sort: 'text',   filter: 'select', default: true },
    { key: 'default_unit',  label: 'Unit',           sort: 'text',   filter: 'text',   default: true },
    { key: 'default_price', label: 'Price',          sort: 'number', filter: 'range',  default: true },
    { key: 'default_cost',  label: 'Cost',           sort: 'number', filter: 'range',  default: false },
    { key: 'item_notes',    label: 'Notes',          sort: 'text',   filter: 'text',   default: true },
    { key: 'use_count',     label: 'Uses',           sort: 'number', filter: 'text',   default: true },
    { key: 'last_used',     label: 'Last used',      sort: 'date',   filter: 'text',   default: true },
    { key: 'description',   label: 'Description',   sort: 'text',   filter: 'text',   default: false },
    { key: 'category',      label: 'Category',      sort: 'text',   filter: 'select', default: false },
    { key: 'source_label',  label: 'Source',         sort: 'text',   filter: 'select', default: true  },
    { key: 'status',        label: 'Status',         sort: 'text',   filter: 'select', default: false },
  ];

  const rowData = rows.map(r => ({
    id: r.id,
    part_number: r.part_number ?? '',
    name: r.name ?? '',
    item_type: r.item_type ?? 'product',
    item_type_label: TYPE_LABELS[r.item_type] ?? r.item_type ?? '',
    description: r.description ?? '',
    category: r.category ?? '',
    default_unit: r.default_unit ?? 'ea',
    default_price: r.default_price != null ? Number(r.default_price) : 0,
    default_price_display: fmtDollar(r.default_price),
    default_cost: r.default_cost != null ? Number(r.default_cost) : '',
    default_cost_display: r.default_cost != null ? fmtDollar(r.default_cost) : '',
    item_notes: r.item_notes ?? '',
    use_count: r.use_count ?? 0,
    last_used: r.last_used_at ? r.last_used_at.slice(0, 10) : '',
    source: r.source ?? 'manual',
    source_label: SOURCE_LABELS[r.source] ?? r.source ?? 'Manual',
    status: r.active ? 'Active' : 'Inactive',
    active: r.active,
  }));

  const errText = (k) => (errors[k] ? html`<small class="error">${errors[k]}</small>` : '');

  const body = html`
    ${librarySubNav('items')}

    <section class="card">
      <div class="card-header">
        <h1>Line Items Library</h1>
        ${listToolbar({ id: 'items', count: rows.length, columns })}
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
                      data-row-href="/library/items/${escape(r.id)}"
                      ${raw(rowDataAttrs(columns, r))}
                      ${!r.active ? 'class="inactive"' : ''}>
                    <td class="col-part_number" data-col="part_number">
                      ${ieText('part_number', r.part_number)}
                    </td>
                    <td class="col-name" data-col="name">
                      ${ieText('name', r.name)}
                    </td>
                    <td class="col-item_type_label" data-col="item_type_label">${escape(r.item_type_label)}</td>
                    <td class="col-default_unit" data-col="default_unit">
                      ${ieText('default_unit', r.default_unit)}
                    </td>
                    <td class="col-default_price num" data-col="default_price">
                      ${ieText('default_price', r.default_price === 0 ? '' : String(r.default_price), {
                        inputType: 'number',
                        displayText: r.default_price_display,
                      })}
                    </td>
                    <td class="col-default_cost num" data-col="default_cost">
                      ${ieText('default_cost', r.default_cost === '' ? '' : String(r.default_cost), {
                        inputType: 'number',
                        displayText: r.default_cost_display,
                      })}
                    </td>
                    <td class="col-item_notes" data-col="item_notes">
                      ${ieText('item_notes', r.item_notes)}
                    </td>
                    <td class="col-use_count num" data-col="use_count">${r.use_count}</td>
                    <td class="col-last_used" data-col="last_used"><small class="muted">${escape(r.last_used)}</small></td>
                    <td class="col-description" data-col="description">
                      ${ieText('description', r.description)}
                    </td>
                    <td class="col-category" data-col="category">
                      ${ieText('category', r.category)}
                    </td>
                    <td class="col-source_label" data-col="source_label"><small class="muted">${escape(r.source_label)}</small></td>
                    <td class="col-status" data-col="status">
                      ${ieSelect('active', r.active ? '1' : '0', [
                        { value: '1', label: 'Active' },
                        { value: '0', label: 'Inactive' },
                      ])}
                    </td>
                  </tr>
                `)}
              </tbody>
              <tfoot>
                <tr><th colspan="12">${rows.length} item${rows.length === 1 ? '' : 's'}</th></tr>
              </tfoot>
            </table>
          </div>
          <script>${raw(listScript('pipeline.libItems.v1', 'name', 'asc'))}</script>
          <script>${raw(listInlineEditScript('/library/items/:id/patch', {
            fieldAttrMap: { active: 'status' },
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

      ${hasRole(user, 'admin') ? html`
        <h2 class="section-h">Import MRPeasy CSV</h2>
        <div x-data="mrpImport()">
          <input type="file" accept=".csv" @change="upload($event)" :disabled="busy" style="margin-right:0.5rem">
          <span x-show="busy" class="muted">Importing... <span x-text="status"></span></span>
          <span x-show="result" x-text="result" style="color:#16a34a;font-weight:500"></span>
          <span x-show="error" x-text="error" style="color:#cf222e"></span>
        </div>
        <script>
        document.addEventListener('alpine:init', function() {
          Alpine.data('mrpImport', function() {
            return {
              busy: false, status: '', result: '', error: '',
              upload: function(e) {
                var self = this;
                var file = e.target.files[0];
                if (!file) return;
                self.busy = true; self.status = 'Uploading...'; self.result = ''; self.error = '';
                var fd = new FormData();
                fd.append('file', file);
                fetch('/api/mrpeasy-import', {
                  method: 'POST', credentials: 'same-origin', body: fd,
                }).then(function(r) { return r.json(); })
                  .then(function(j) {
                    self.busy = false;
                    if (j.ok) {
                      self.result = 'Imported ' + j.imported + ' items' + (j.skipped ? ' (' + j.skipped + ' skipped)' : '') + '.';
                      setTimeout(function() { location.reload(); }, 1500);
                    } else {
                      self.error = j.error || 'Import failed.';
                    }
                  })
                  .catch(function(err) { self.busy = false; self.error = 'Upload failed: ' + err.message; });
              }
            };
          });
        });
        </script>

        <h2 class="section-h">Katana Sync</h2>
        <div x-data="katanaSync()">
          <button class="btn" @click="sync()" :disabled="busy">Refresh from Katana</button>
          <span x-show="busy" class="muted">Syncing...</span>
          <span x-show="result" x-text="result" style="color:#16a34a;font-weight:500"></span>
          <span x-show="error" x-text="error" style="color:#cf222e"></span>
        </div>
        <script>
        document.addEventListener('alpine:init', function() {
          Alpine.data('katanaSync', function() {
            return {
              busy: false, result: '', error: '',
              sync: function() {
                var self = this;
                self.busy = true; self.result = ''; self.error = '';
                fetch('/api/katana-sync', {
                  method: 'POST', credentials: 'same-origin',
                }).then(function(r) { return r.json(); })
                  .then(function(j) {
                    self.busy = false;
                    if (j.ok) {
                      self.result = 'Synced ' + j.products + ' products + ' + j.services + ' services from Katana.';
                      setTimeout(function() { location.reload(); }, 1500);
                    } else {
                      self.error = j.reason || j.error || 'Sync failed.';
                    }
                  })
                  .catch(function(err) { self.busy = false; self.error = 'Sync failed: ' + err.message; });
              }
            };
          });
        });
        </script>
      ` : ''}
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
