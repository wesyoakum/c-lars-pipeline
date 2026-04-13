// functions/library/labor-items/[id]/index.js
//
// GET  /library/labor-items/:id   — edit form (description + workcenter grid)
// POST /library/labor-items/:id   — update description AND rewrite the
//                                   labor_item_entries rows for this item

import { one, all, stmt, batch } from '../../../lib/db.js';
import { auditStmt, diff } from '../../../lib/audit.js';
import {
  validateLaborItem,
  validateWorkcenterEntries,
} from '../../../lib/validators.js';
import { layout, htmlResponse, html, escape } from '../../../lib/layout.js';
import { now } from '../../../lib/ids.js';
import { redirectWithFlash, formBody, readFlash } from '../../../lib/http.js';
import {
  loadPricingSettings,
  computeLaborItemCost,
  workcenterEntryCost,
  fmtDollar,
} from '../../../lib/pricing.js';

export async function onRequestGet(context) {
  return renderEdit(context, {});
}

async function renderEdit(context, { values = null, entriesOverride = null, errors = {} } = {}) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const id = params.id;

  const settings = await loadPricingSettings(env.DB);
  const workcenters = settings.workcenters;

  const item = await one(
    env.DB,
    'SELECT id, description, created_at, updated_at FROM labor_items WHERE id = ?',
    [id]
  );
  if (!item) return new Response('Labor item not found', { status: 404 });

  // Pre-load current entries, keyed by workcenter.
  const existingEntries = await all(
    env.DB,
    'SELECT workcenter, hours, rate FROM labor_item_entries WHERE labor_item_id = ?',
    [id]
  );
  const currentByWc = new Map(existingEntries.map((e) => [e.workcenter, e]));

  // Informational: how many cost builds reference this item?
  const usageRow = await one(
    env.DB,
    'SELECT COUNT(*) AS n FROM cost_build_labor_selections WHERE labor_item_id = ?',
    [id]
  );
  const usage = usageRow?.n ?? 0;

  // Values shown in the form: if a prior submit failed, use what the user
  // typed (values + entriesOverride); otherwise show the DB state.
  const v = values || item;
  const hoursMap = {};
  const ratesMap = {};
  if (entriesOverride) {
    // entriesOverride is the raw parallel hours/rate maps from the POST
    for (const wc of workcenters) {
      hoursMap[wc] = entriesOverride.hours?.[wc] ?? '';
      ratesMap[wc] = entriesOverride.rate?.[wc] ?? '';
    }
  } else {
    for (const wc of workcenters) {
      const row = currentByWc.get(wc);
      hoursMap[wc] = row?.hours ?? '';
      ratesMap[wc] = (row?.rate === null || row?.rate === undefined) ? '' : row.rate;
    }
  }

  const total = computeLaborItemCost(existingEntries, settings);

  const errText = (k) => (errors[k] ? html`<small class="error">${errors[k]}</small>` : '');

  const body = html`
    <section class="card">
      <div class="card-header">
        <h1>Edit labor item</h1>
        <a class="btn" href="/library/labor-items">← All labor items</a>
      </div>

      <form method="post" action="/library/labor-items/${escape(id)}" class="stack-form">
        <div class="field">
          <label>Description</label>
          <input type="text" name="description" value="${v.description ?? ''}" required autofocus>
          ${errText('description')}
        </div>

        <h2 class="section-h">Workcenter hours and rates</h2>
        <p class="muted">
          Enter hours per workcenter. Blank rate uses the default
          ${fmtDollar(settings.defaultLaborRate)}/hr from pricing settings.
          Rows with no hours are not stored.
        </p>

        <table class="data compact">
          <thead>
            <tr>
              <th>Workcenter</th>
              <th class="num">Hours</th>
              <th class="num">Rate ($/hr)</th>
              <th class="num">Cost</th>
            </tr>
          </thead>
          <tbody>
            ${workcenters.map((wc) => {
              const rowEntry = currentByWc.get(wc);
              const rowCost = rowEntry
                ? workcenterEntryCost(rowEntry.hours, rowEntry.rate, settings)
                : 0;
              return html`
                <tr>
                  <td>${escape(wc)}</td>
                  <td class="num">
                    <input type="text" name="hours[${escape(wc)}]"
                           value="${hoursMap[wc]}" placeholder="0" class="num-input">
                    ${errText(`hours_${wc}`)}
                  </td>
                  <td class="num">
                    <input type="text" name="rate[${escape(wc)}]"
                           value="${ratesMap[wc]}"
                           placeholder="${settings.defaultLaborRate}" class="num-input">
                    ${errText(`rate_${wc}`)}
                  </td>
                  <td class="num">${rowCost ? fmtDollar(rowCost) : '—'}</td>
                </tr>
              `;
            })}
          </tbody>
          <tfoot>
            <tr>
              <th colspan="3">Current total (stored)</th>
              <th class="num">${fmtDollar(total)}</th>
            </tr>
          </tfoot>
        </table>

        <p class="muted">Used in ${usage} cost build${usage === 1 ? '' : 's'}.</p>

        <div class="form-actions">
          <button class="btn primary" type="submit">Save</button>
          <a class="btn" href="/library/labor-items">Cancel</a>
        </div>
      </form>

      <form method="post" action="/library/labor-items/${escape(id)}/delete"
            onsubmit="return confirm('Delete this labor item? Any cost-build selections linking to it will also be removed.')">
        <button class="btn danger" type="submit">Delete item</button>
      </form>
    </section>
  `;

  return htmlResponse(
    layout('Edit labor item', body, {
      user,
      env: data?.env, commitSha: data?.commitSha,
      activeNav: '/library',
      flash: readFlash(url),
    })
  );
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const id = params.id;
  const input = await formBody(request);

  const before = await one(
    env.DB,
    'SELECT id, description FROM labor_items WHERE id = ?',
    [id]
  );
  if (!before) return new Response('Labor item not found', { status: 404 });

  const settings = await loadPricingSettings(env.DB);

  const { ok, value, errors } = validateLaborItem(input);
  const wcRes = validateWorkcenterEntries(
    input.hours,
    input.rate,
    settings.workcenters
  );

  const allErrors = { ...(ok ? {} : errors), ...(wcRes.ok ? {} : wcRes.errors) };

  if (Object.keys(allErrors).length) {
    return renderEdit(context, {
      values: input,
      entriesOverride: { hours: input.hours || {}, rate: input.rate || {} },
      errors: allErrors,
    });
  }

  const ts = now();
  const changes = diff(before, value, ['description']);

  const statements = [
    stmt(
      env.DB,
      'UPDATE labor_items SET description = ?, updated_at = ? WHERE id = ?',
      [value.description, ts, id]
    ),
    // Rewrite entries: simplest correct strategy is delete-then-insert.
    stmt(env.DB, 'DELETE FROM labor_item_entries WHERE labor_item_id = ?', [id]),
  ];
  for (const entry of wcRes.value) {
    statements.push(
      stmt(
        env.DB,
        `INSERT INTO labor_item_entries (labor_item_id, workcenter, hours, rate)
         VALUES (?, ?, ?, ?)`,
        [id, entry.workcenter, entry.hours, entry.rate]
      )
    );
  }
  statements.push(
    auditStmt(env.DB, {
      entityType: 'labor_item',
      entityId: id,
      eventType: 'updated',
      user,
      summary: `Updated labor item "${value.description}"`,
      changes: {
        ...(changes || {}),
        entries: { to: wcRes.value },
      },
    })
  );

  await batch(env.DB, statements);
  return redirectWithFlash(
    `/library/labor-items/${id}`,
    `Saved "${value.description}".`
  );
}
