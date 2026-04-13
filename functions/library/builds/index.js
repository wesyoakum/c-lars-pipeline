// functions/library/builds/index.js
//
// GET  /library/builds        — list all build templates
// POST /library/builds        — create a new build template
//
// Builds library entries are reusable pricing engine templates.
// They use the same pricing engine as cost builds but are not tied
// to any opportunity.

import { all, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { layout, htmlResponse, html, escape } from '../../lib/layout.js';
import { uuid, now } from '../../lib/ids.js';
import { redirectWithFlash, formBody, readFlash } from '../../lib/http.js';
import {
  loadPricingSettings,
  computeFromBundle,
  fmtDollar,
} from '../../lib/pricing.js';

export async function onRequestGet(context) {
  return renderList(context, {});
}

async function renderList(context, { values = {}, errors = {} } = {}) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);

  const rows = await all(
    env.DB,
    `SELECT * FROM builds_library ORDER BY name`
  );

  // Compute quote price for each build using the pricing engine.
  const settings = await loadPricingSettings(env.DB);
  const summaries = [];
  for (const build of rows) {
    const currentLabor = await all(
      env.DB,
      'SELECT workcenter, hours, rate FROM builds_library_labor WHERE builds_library_id = ?',
      [build.id]
    );
    const dmSelections = await all(
      env.DB,
      `SELECT dm.id, dm.description, dm.cost
         FROM builds_library_dm_selections sel
         JOIN dm_items dm ON dm.id = sel.dm_item_id
        WHERE sel.builds_library_id = ?
        ORDER BY dm.description`,
      [build.id]
    );
    const laborSelectionRows = await all(
      env.DB,
      `SELECT li.id, li.description
         FROM builds_library_labor_selections sel
         JOIN labor_items li ON li.id = sel.labor_item_id
        WHERE sel.builds_library_id = ?
        ORDER BY li.description`,
      [build.id]
    );
    const laborSelections = [];
    for (const li of laborSelectionRows) {
      const entries = await all(
        env.DB,
        'SELECT workcenter, hours, rate FROM labor_item_entries WHERE labor_item_id = ?',
        [li.id]
      );
      laborSelections.push({ ...li, entries });
    }
    const bundle = { build, currentLabor, dmSelections, laborSelections };
    const { pricing } = computeFromBundle(bundle, settings);
    summaries.push({
      ...build,
      quotePrice: pricing.effective.quote,
      totalCost: pricing.effective.totalCost,
    });
  }

  const errText = (k) => (errors[k] ? html`<small class="error">${errors[k]}</small>` : '');

  const body = html`
    <section class="card">
      <div class="card-header">
        <h1>Builds Library</h1>
        <a class="btn" href="/library">← Library</a>
      </div>

      <p class="muted">
        Reusable pricing templates. Create a build here and use it as a
        starting point when adding cost builds to opportunities.
      </p>

      <form method="post" action="/library/builds" class="inline-form">
        <div class="field">
          <label>Name</label>
          <input type="text" name="name" value="${values.name ?? ''}"
                 required autofocus>
          ${errText('name')}
        </div>
        <div class="field">
          <label>Description</label>
          <input type="text" name="description" value="${values.description ?? ''}"
                 placeholder="Optional">
        </div>
        <button class="btn primary" type="submit">Create build</button>
      </form>

      ${summaries.length === 0
        ? html`<p class="muted">No build templates yet.</p>`
        : html`
          <table class="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Description</th>
                <th class="num">Total Cost</th>
                <th class="num">Quote Price</th>
                <th>Updated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${summaries.map((r) => html`
                <tr>
                  <td><a href="/library/builds/${escape(r.id)}">${escape(r.name)}</a></td>
                  <td>${escape(r.description ?? '')}</td>
                  <td class="num">${fmtDollar(r.totalCost)}</td>
                  <td class="num">${fmtDollar(r.quotePrice)}</td>
                  <td><small class="muted">${escape((r.updated_at ?? '').slice(0, 10))}</small></td>
                  <td class="row-actions">
                    <a class="btn small" href="/library/builds/${escape(r.id)}">Edit</a>
                  </td>
                </tr>
              `)}
            </tbody>
          </table>
        `}
    </section>
  `;

  return htmlResponse(
    layout('Builds Library', body, {
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

  const name = (input.name || '').trim();
  if (!name) {
    return renderList(context, {
      values: input,
      errors: { name: 'Name is required' },
    });
  }

  const id = uuid();
  const ts = now();
  const description = (input.description || '').trim() || null;

  await batch(env.DB, [
    stmt(
      env.DB,
      `INSERT INTO builds_library (id, name, description, active, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
      [id, name, description, ts, ts]
    ),
    auditStmt(env.DB, {
      entityType: 'builds_library',
      entityId: id,
      eventType: 'created',
      user,
      summary: `Created build template "${name}"`,
      changes: { name, description },
    }),
  ]);

  return redirectWithFlash(`/library/builds/${id}`, `Created "${name}".`);
}
