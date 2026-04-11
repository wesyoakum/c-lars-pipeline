// functions/library/labor-items/index.js
//
// GET  /library/labor-items     — list + inline-add form
// POST /library/labor-items     — create a new labor item (description only;
//                                  hours/rates edited on the detail page)
//
// Labor library items are globally shared. Each item has a description
// plus a set of per-workcenter (hours, rate) entries (labor_item_entries).
// A cost build that enables "Use labor library" and selects one or more
// items gets their total cost folded into the DL category.

import { all, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { validateLaborItem } from '../../lib/validators.js';
import { layout, htmlResponse, html, escape } from '../../lib/layout.js';
import { uuid, now } from '../../lib/ids.js';
import { redirectWithFlash, formBody, readFlash } from '../../lib/http.js';
import {
  loadPricingSettings,
  computeLaborItemCost,
  fmtDollar,
} from '../../lib/pricing.js';

export async function onRequestGet(context) {
  return renderList(context, {});
}

export async function renderList(context, { values = {}, errors = {} } = {}) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);

  const settings = await loadPricingSettings(env.DB);

  const items = await all(
    env.DB,
    `SELECT id, description, updated_at
       FROM labor_items
      ORDER BY description`
  );

  // Load all entries in one query; bucket them by labor_item_id.
  const entries = await all(
    env.DB,
    'SELECT labor_item_id, workcenter, hours, rate FROM labor_item_entries'
  );
  const byItem = new Map();
  for (const e of entries) {
    if (!byItem.has(e.labor_item_id)) byItem.set(e.labor_item_id, []);
    byItem.get(e.labor_item_id).push(e);
  }

  let grandTotal = 0;
  const rows = items.map((it) => {
    const itemEntries = byItem.get(it.id) || [];
    const cost = computeLaborItemCost(itemEntries, settings);
    grandTotal += cost;
    return { ...it, cost, entryCount: itemEntries.length };
  });

  const errText = (k) => (errors[k] ? html`<small class="error">${errors[k]}</small>` : '');

  const body = html`
    <section class="card">
      <div class="card-header">
        <h1>Labor library</h1>
        <a class="btn" href="/library">← Library</a>
      </div>

      <p class="muted">
        Shared catalog of reusable labor packages. Each package holds
        hours and rates per workcenter; cost builds can link one or
        more into the Direct Labor category.
        Default rate: <strong>${fmtDollar(settings.defaultLaborRate)}</strong>/hr.
      </p>

      <form method="post" action="/library/labor-items" class="inline-form">
        <div class="field">
          <label>Description</label>
          <input type="text" name="description" value="${values.description ?? ''}"
                 required autofocus>
          ${errText('description')}
        </div>
        <button class="btn primary" type="submit">Add item</button>
      </form>

      ${rows.length === 0
        ? html`<p class="muted">No labor items yet.</p>`
        : html`
          <table class="data">
            <thead>
              <tr>
                <th>Description</th>
                <th class="num">Workcenters</th>
                <th class="num">Cost</th>
                <th>Updated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((r) => html`
                <tr>
                  <td><a href="/library/labor-items/${escape(r.id)}">${escape(r.description)}</a></td>
                  <td class="num">${r.entryCount}</td>
                  <td class="num">${fmtDollar(r.cost)}</td>
                  <td><small class="muted">${escape((r.updated_at ?? '').slice(0, 10))}</small></td>
                  <td class="row-actions">
                    <a class="btn small" href="/library/labor-items/${escape(r.id)}">Edit</a>
                  </td>
                </tr>
              `)}
            </tbody>
            <tfoot>
              <tr>
                <th>Total (${rows.length} item${rows.length === 1 ? '' : 's'})</th>
                <th></th>
                <th class="num">${fmtDollar(grandTotal)}</th>
                <th></th>
                <th></th>
              </tr>
            </tfoot>
          </table>
        `}
    </section>
  `;

  return htmlResponse(
    layout('Labor library', body, {
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
  const { ok, value, errors } = validateLaborItem(input);

  if (!ok) {
    return renderList(context, { values: input, errors });
  }

  const id = uuid();
  const ts = now();

  await batch(env.DB, [
    stmt(
      env.DB,
      `INSERT INTO labor_items (id, description, created_at, updated_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?)`,
      [id, value.description, ts, ts, user?.id ?? null]
    ),
    auditStmt(env.DB, {
      entityType: 'labor_item',
      entityId: id,
      eventType: 'created',
      user,
      summary: `Created labor item "${value.description}"`,
      changes: value,
    }),
  ]);

  return redirectWithFlash(
    `/library/labor-items/${id}`,
    `Added "${value.description}". Enter hours per workcenter below.`
  );
}
