// functions/library/items/[id]/index.js
//
// GET  /library/items/:id   — edit form
// POST /library/items/:id   — update

import { one, stmt, batch } from '../../../lib/db.js';
import { auditStmt, diff } from '../../../lib/audit.js';
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
    `SELECT id, name, description, default_unit, default_price, category, notes, active,
            created_at, updated_at
       FROM items_library WHERE id = ?`,
    [id]
  );
  if (!item) {
    return new Response('Library item not found', { status: 404 });
  }

  const v = values || item;
  const errText = (k) => (errors[k] ? html`<small class="error">${errors[k]}</small>` : '');

  // For the active toggle, figure out the checked state from values or DB.
  const isActive = values ? (values.active === 'on' || values.active === '1') : !!item.active;

  const body = html`
    <section class="card">
      <div class="card-header">
        <h1>Edit library item</h1>
        <a class="btn" href="/library/items">← All items</a>
      </div>

      <form method="post" action="/library/items/${escape(id)}" class="stack-form">
        <div class="field">
          <label>Name</label>
          <input type="text" name="name" value="${v.name ?? ''}" required autofocus>
          ${errText('name')}
        </div>
        <div class="field">
          <label>Description</label>
          <input type="text" name="description" value="${v.description ?? ''}">
        </div>
        <div class="field">
          <label>Category</label>
          <input type="text" name="category" value="${v.category ?? ''}">
        </div>
        <div class="field">
          <label>Default Unit</label>
          <input type="text" name="default_unit" value="${v.default_unit ?? 'ea'}" placeholder="ea">
        </div>
        <div class="field">
          <label>Default Price</label>
          <input type="text" name="default_price" value="${v.default_price ?? ''}" placeholder="0.00">
          ${errText('default_price')}
        </div>
        <div class="field">
          <label>Notes</label>
          <textarea name="notes" rows="3">${v.notes ?? ''}</textarea>
        </div>
        <div class="field checkbox">
          <label>
            <input type="checkbox" name="active" ${isActive ? 'checked' : ''}> Active
          </label>
        </div>
        <p class="muted">
          Current price: <strong>${fmtDollar(item.default_price)}</strong>
        </p>
        <div class="form-actions">
          <button class="btn primary" type="submit">Save</button>
          <a class="btn" href="/library/items">Cancel</a>
        </div>
      </form>

      <form method="post" action="/library/items/${escape(id)}/delete"
            onsubmit="return confirm('Delete this library item? This cannot be undone.')">
        <button class="btn danger" type="submit">Delete item</button>
      </form>
    </section>
  `;

  return htmlResponse(
    layout('Edit library item', body, {
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
    `SELECT id, name, description, default_unit, default_price, category, notes, active
       FROM items_library WHERE id = ?`,
    [id]
  );
  if (!before) return new Response('Library item not found', { status: 404 });

  const errors = {};
  const name = (input.name ?? '').trim();
  if (!name) errors.name = 'Name is required.';

  const defaultPrice = input.default_price ? parseFloat(input.default_price) : 0;
  if (input.default_price && isNaN(defaultPrice)) {
    errors.default_price = 'Default price must be a number.';
  }

  if (Object.keys(errors).length) {
    return renderEdit(context, { values: input, errors });
  }

  const ts = now();
  const description = (input.description ?? '').trim() || null;
  const category = (input.category ?? '').trim() || null;
  const defaultUnit = (input.default_unit ?? '').trim() || 'ea';
  const notes = (input.notes ?? '').trim() || null;
  const active = input.active === 'on' || input.active === '1' ? 1 : 0;

  const value = { name, description, default_unit: defaultUnit, default_price: defaultPrice, category, notes, active };
  const changes = diff(before, value, ['name', 'description', 'default_unit', 'default_price', 'category', 'notes', 'active']);

  const statements = [
    stmt(
      env.DB,
      `UPDATE items_library
          SET name = ?, description = ?, default_unit = ?, default_price = ?,
              category = ?, notes = ?, active = ?, updated_at = ?
        WHERE id = ?`,
      [name, description, defaultUnit, defaultPrice, category, notes, active, ts, id]
    ),
  ];
  if (changes) {
    statements.push(
      auditStmt(env.DB, {
        entityType: 'items_library',
        entityId: id,
        eventType: 'updated',
        user,
        summary: `Updated library item "${name}"`,
        changes,
      })
    );
  }

  await batch(env.DB, statements);
  return redirectWithFlash('/library/items', `Saved "${name}".`);
}
