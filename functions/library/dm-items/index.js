// functions/library/dm-items/index.js
//
// GET  /library/dm-items        — list + inline-add form
// POST /library/dm-items        — create a new DM item

import { all, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { validateDmItem } from '../../lib/validators.js';
import { layout, htmlResponse, html, raw, escape } from '../../lib/layout.js';
import { uuid, now } from '../../lib/ids.js';
import { redirectWithFlash, formBody, readFlash } from '../../lib/http.js';
import { fmtDollar } from '../../lib/pricing.js';
import { listScript, listTableHead, listToolbar, rowDataAttrs } from '../../lib/list-table.js';

export async function onRequestGet(context) {
  return renderList(context, {});
}

export async function renderList(context, { values = {}, errors = {} } = {}) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);

  const rows = await all(
    env.DB,
    `SELECT id, description, cost, updated_at
       FROM dm_items
      ORDER BY description`
  );

  const total = rows.reduce((a, r) => a + (Number(r.cost) || 0), 0);

  const columns = [
    { key: 'description', label: 'Description', sort: 'text',   filter: 'text',   default: true },
    { key: 'cost',        label: 'Cost',         sort: 'number', filter: 'range',  default: true },
    { key: 'updated',     label: 'Updated',      sort: 'date',   filter: 'text',   default: true },
  ];

  const rowData = rows.map(r => ({
    id: r.id,
    description: r.description ?? '',
    cost: Number(r.cost) || 0,
    cost_display: fmtDollar(r.cost),
    updated: (r.updated_at ?? '').slice(0, 10),
  }));

  const errText = (k) => (errors[k] ? html`<small class="error">${errors[k]}</small>` : '');

  const body = html`
    <section class="card">
      <div class="card-header">
        <h1>Direct Material library</h1>
        <div style="display:flex;align-items:center;gap:0.5rem">
          ${listToolbar({ id: 'dm', count: rows.length, columns })}
          <a class="btn" href="/library">\u2190 Library</a>
        </div>
      </div>

      <p class="muted">
        Shared catalog of DM items. Price builds can link to one or more
        of these to auto-populate the Direct Material category.
      </p>

      <form method="post" action="/library/dm-items" class="inline-form">
        <div class="field">
          <label>Description</label>
          <input type="text" name="description" value="${values.description ?? ''}"
                 required autofocus>
          ${errText('description')}
        </div>
        <div class="field">
          <label>Cost (USD)</label>
          <input type="text" name="cost" value="${values.cost ?? ''}"
                 placeholder="0.00">
          ${errText('cost')}
        </div>
        <button class="btn primary" type="submit">Add item</button>
      </form>

      ${rows.length === 0
        ? html`<p class="muted">No DM items yet.</p>`
        : html`
          <div class="opp-list" data-columns="${escape(JSON.stringify(columns))}">
            <table class="data opp-list-table">
              ${listTableHead(columns, rowData)}
              <tbody data-role="rows">
                ${rowData.map(r => html`
                  <tr data-row-id="${escape(r.id)}"
                      ${raw(rowDataAttrs(columns, r))}>
                    <td class="col-description" data-col="description"><a href="/library/dm-items/${escape(r.id)}">${escape(r.description)}</a></td>
                    <td class="col-cost num" data-col="cost">${escape(r.cost_display)}</td>
                    <td class="col-updated" data-col="updated"><small class="muted">${escape(r.updated)}</small></td>
                  </tr>
                `)}
              </tbody>
              <tfoot>
                <tr>
                  <th>Total (${rows.length} item${rows.length === 1 ? '' : 's'})</th>
                  <th class="num">${fmtDollar(total)}</th>
                  <th></th>
                </tr>
              </tfoot>
            </table>
          </div>
          <script>${raw(listScript('pms.libDm.v1', 'description', 'asc'))}</script>
        `}
    </section>
  `;

  return htmlResponse(
    layout('DM library', body, {
      user,
      env: data?.env,
      activeNav: '/library',
      flash: readFlash(url),
      breadcrumbs: [
        { label: 'Library', href: '/library' },
        { label: 'Direct Materials' },
      ],
    })
  );
}

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const input = await formBody(request);
  const { ok, value, errors } = validateDmItem(input);

  if (!ok) {
    return renderList(context, { values: input, errors });
  }

  const id = uuid();
  const ts = now();

  await batch(env.DB, [
    stmt(
      env.DB,
      `INSERT INTO dm_items (id, description, cost, created_at, updated_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, value.description, value.cost, ts, ts, user?.id ?? null]
    ),
    auditStmt(env.DB, {
      entityType: 'dm_item',
      entityId: id,
      eventType: 'created',
      user,
      summary: `Created DM item "${value.description}" (${fmtDollar(value.cost)})`,
      changes: value,
    }),
  ]);

  return redirectWithFlash('/library/dm-items', `Added "${value.description}".`);
}
