// functions/library/dm-items/[id]/index.js
//
// GET  /library/dm-items/:id   — edit form
// POST /library/dm-items/:id   — update

import { one, stmt, batch } from '../../../lib/db.js';
import { auditStmt, diff } from '../../../lib/audit.js';
import { validateDmItem } from '../../../lib/validators.js';
import { layout, htmlResponse, html, escape } from '../../../lib/layout.js';
import { now } from '../../../lib/ids.js';
import { redirectWithFlash, formBody, readFlash } from '../../../lib/http.js';
import { fmtDollar } from '../../../lib/pricing.js';

export async function onRequestGet(context) {
  return renderEdit(context, {});
}

async function renderEdit(context, { values = null, errors = {} } = {}) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const id = params.id;

  const item = await one(
    env.DB,
    'SELECT id, description, cost, created_at, updated_at FROM dm_items WHERE id = ?',
    [id]
  );
  if (!item) {
    return new Response('DM item not found', { status: 404 });
  }

  // Count how many price builds currently reference this item (informational).
  const usageRow = await one(
    env.DB,
    'SELECT COUNT(*) AS n FROM cost_build_dm_selections WHERE dm_item_id = ?',
    [id]
  );
  const usage = usageRow?.n ?? 0;

  const v = values || item;
  const errText = (k) => (errors[k] ? html`<small class="error">${errors[k]}</small>` : '');

  const body = html`
    <section class="card">
      <div class="card-header">
        <h1>Edit DM item</h1>
        <a class="btn" href="/library/dm-items">← All DM items</a>
      </div>

      <form method="post" action="/library/dm-items/${escape(id)}" class="stack-form">
        <div class="field">
          <label>Description</label>
          <input type="text" name="description" value="${v.description ?? ''}" required autofocus>
          ${errText('description')}
        </div>
        <div class="field">
          <label>Cost (USD)</label>
          <input type="text" name="cost" value="${v.cost ?? ''}" placeholder="0.00">
          ${errText('cost')}
        </div>
        <p class="muted">
          Current: <strong>${fmtDollar(item.cost)}</strong> ·
          Used in ${usage} price build${usage === 1 ? '' : 's'}.
        </p>
        <div class="form-actions">
          <button class="btn primary" type="submit">Save</button>
          <a class="btn" href="/library/dm-items">Cancel</a>
        </div>
      </form>

      <form method="post" action="/library/dm-items/${escape(id)}/delete"
            onsubmit="return confirm('Delete this DM item? Any cost-build selections that link to it will also be removed.')">
        <button class="btn danger" type="submit">Delete item</button>
      </form>
    </section>
  `;

  return htmlResponse(
    layout('Edit DM item', body, {
      user,
      env: data?.env,
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
    'SELECT id, description, cost FROM dm_items WHERE id = ?',
    [id]
  );
  if (!before) return new Response('DM item not found', { status: 404 });

  const { ok, value, errors } = validateDmItem(input);
  if (!ok) {
    return renderEdit(context, { values: input, errors });
  }

  const ts = now();
  const changes = diff(before, value, ['description', 'cost']);

  const statements = [
    stmt(
      env.DB,
      'UPDATE dm_items SET description = ?, cost = ?, updated_at = ? WHERE id = ?',
      [value.description, value.cost, ts, id]
    ),
  ];
  if (changes) {
    statements.push(
      auditStmt(env.DB, {
        entityType: 'dm_item',
        entityId: id,
        eventType: 'updated',
        user,
        summary: `Updated DM item "${value.description}"`,
        changes,
      })
    );
  }

  await batch(env.DB, statements);
  return redirectWithFlash('/library/dm-items', `Saved "${value.description}".`);
}
