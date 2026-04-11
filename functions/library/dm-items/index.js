// functions/library/dm-items/index.js
//
// GET  /library/dm-items        — list + inline-add form
// POST /library/dm-items        — create a new DM item
//
// Direct Material library items are globally shared — there is no
// per-user or per-opportunity filtering. Each item has a description
// and a flat dollar cost. When a cost build enables "Use DM library"
// and selects one or more items, the pricing engine sums their costs
// into the DM total.

import { all, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { validateDmItem } from '../../lib/validators.js';
import { layout, htmlResponse, html, escape } from '../../lib/layout.js';
import { uuid, now } from '../../lib/ids.js';
import { redirectWithFlash, formBody, readFlash } from '../../lib/http.js';
import { fmtDollar } from '../../lib/pricing.js';

export async function onRequestGet(context) {
  return renderList(context, {});
}

/**
 * Render the DM items list + add form. Extracted so POST handlers can
 * re-render in place when validation fails.
 */
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

  const errText = (k) => (errors[k] ? html`<small class="error">${errors[k]}</small>` : '');

  const body = html`
    <section class="card">
      <div class="card-header">
        <h1>Direct Material library</h1>
        <a class="btn" href="/library">← Library</a>
      </div>

      <p class="muted">
        Shared catalog of DM items. Cost builds can link to one or more
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
          <table class="data">
            <thead>
              <tr>
                <th>Description</th>
                <th class="num">Cost</th>
                <th>Updated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((r) => html`
                <tr>
                  <td><a href="/library/dm-items/${escape(r.id)}">${escape(r.description)}</a></td>
                  <td class="num">${fmtDollar(r.cost)}</td>
                  <td><small class="muted">${escape((r.updated_at ?? '').slice(0, 10))}</small></td>
                  <td class="row-actions">
                    <a class="btn small" href="/library/dm-items/${escape(r.id)}">Edit</a>
                  </td>
                </tr>
              `)}
            </tbody>
            <tfoot>
              <tr>
                <th>Total (${rows.length} item${rows.length === 1 ? '' : 's'})</th>
                <th class="num">${fmtDollar(total)}</th>
                <th></th>
                <th></th>
              </tr>
            </tfoot>
          </table>
        `}
    </section>
  `;

  return htmlResponse(
    layout('DM library', body, {
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
