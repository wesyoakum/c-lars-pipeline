// functions/library/items/[id]/index.js
//
// GET  /library/items/:id   — detail with inline-editable fields
// POST /library/items/:id   — (kept for backward compat / non-JS fallback)
//
// Fields auto-save via fetch POST to /library/items/:id/patch.

import { one, stmt, batch } from '../../../lib/db.js';
import { auditStmt, diff } from '../../../lib/audit.js';
import { layout, htmlResponse, html, escape, raw } from '../../../lib/layout.js';
import { now } from '../../../lib/ids.js';
import { redirectWithFlash, formBody, readFlash } from '../../../lib/http.js';
import { fmtDollar } from '../../../lib/pricing.js';

// ---- helpers for inline-editable fields ----------------------------------

function inlineText(field, value, opts = {}) {
  const display = value || opts.placeholder || '—';
  const displayClass = value ? '' : 'muted';
  return html`<span class="ie" data-field="${field}" data-type="text" ${opts.inputType ? `data-input-type="${opts.inputType}"` : ''}>
    <span class="ie-display ${displayClass}">${escape(display)}</span>
  </span>`;
}

function inlineTextarea(field, value, opts = {}) {
  const display = value || opts.placeholder || '—';
  const displayClass = value ? '' : 'muted';
  return html`<span class="ie" data-field="${field}" data-type="textarea">
    <span class="ie-display ${displayClass}">${escape(display)}</span>
    <span class="ie-raw" hidden>${escape(value ?? '')}</span>
  </span>`;
}

function inlineMoney(field, value) {
  const display = value != null && value !== '' ? fmtDollar(value) : '—';
  const displayClass = value != null && value !== '' ? '' : 'muted';
  return html`<span class="ie" data-field="${field}" data-type="text" data-input-type="number">
    <span class="ie-display ${displayClass}">${escape(display)}</span>
    <span class="ie-raw" hidden>${value ?? ''}</span>
  </span>`;
}

// ---- GET handler ---------------------------------------------------------

export async function onRequestGet(context) {
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
    return htmlResponse(layout('Not found', '<section class="card"><h1>Library item not found</h1><p><a href="/library/items">Back</a></p></section>', {
      user, env: data?.env, activeNav: '/library',
    }), { status: 404 });
  }

  const body = html`
    <section class="card" x-data="libItemInline('${escape(id)}')">
      <div class="card-header">
        <div>
          <h1 class="page-title">${inlineText('name', item.name, { placeholder: '(unnamed)' })}</h1>
          <p class="muted" style="margin:0.15rem 0 0">
            ${item.active
              ? html`<span class="pill pill-success">Active</span>`
              : html`<span class="pill pill-locked">Inactive</span>`}
            · Created ${escape((item.created_at ?? '').slice(0, 16).replace('T', ' '))}
            ${item.updated_at ? html` · Updated ${escape(item.updated_at.slice(0, 16).replace('T', ' '))}` : ''}
          </p>
        </div>
        <div class="header-actions" style="display:flex; gap:0.5rem; align-items:center;">
          <label class="toggle-label" style="display:flex; align-items:center; gap:0.4rem; cursor:pointer; font-size:0.85rem;">
            <input type="checkbox" ${item.active ? 'checked' : ''}
                   @change="toggleActive($event.target.checked)">
            Active
          </label>
          <a class="btn btn-sm" href="/library/items">All items</a>
          <form method="post" action="/library/items/${escape(id)}/delete"
                onsubmit="return confirm('Delete this library item? This cannot be undone.')">
            <button class="btn btn-sm danger" type="submit">Delete</button>
          </form>
        </div>
      </div>

      <div class="detail-grid" style="display:grid; grid-template-columns:1fr 1fr; gap:0.5rem 1rem; margin-top:0.75rem;">
        <div>
          <span class="field-label">Category</span>
          ${inlineText('category', item.category, { placeholder: 'Click to set category...' })}
        </div>
        <div>
          <span class="field-label">Default Unit</span>
          ${inlineText('default_unit', item.default_unit ?? 'ea', { placeholder: 'ea' })}
        </div>
        <div>
          <span class="field-label">Default Price</span>
          ${inlineMoney('default_price', item.default_price)}
        </div>
        <div>
          <span class="field-label">Description</span>
          ${inlineText('description', item.description, { placeholder: 'Click to add description...' })}
        </div>
      </div>

      <div style="margin-top:0.75rem;">
        <span class="field-label">Notes</span>
        ${inlineTextarea('notes', item.notes, { placeholder: 'Click to add notes...' })}
      </div>
    </section>

    <script>${raw(inlineEditScript())}</script>
  `;

  return htmlResponse(
    layout(item.name || 'Library item', body, {
      user,
      env: data?.env,
      activeNav: '/library',
      flash: readFlash(url),
      breadcrumbs: [
        { label: 'Library', href: '/library' },
        { label: 'Line Items', href: '/library/items' },
        { label: item.name || '(unnamed)' },
      ],
    })
  );
}

// ---- POST handler (kept for backward compat / non-JS fallback) ----------

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

  const name = (input.name ?? '').trim();
  if (!name) {
    return redirectWithFlash(`/library/items/${id}`, 'Name is required.');
  }

  const defaultPrice = input.default_price ? parseFloat(input.default_price) : 0;
  if (input.default_price && isNaN(defaultPrice)) {
    return redirectWithFlash(`/library/items/${id}`, 'Default price must be a number.');
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
  return redirectWithFlash(`/library/items/${id}`, `Saved "${name}".`);
}

// ---- Client-side script -------------------------------------------------

function inlineEditScript() {
  return `
function libItemInline(itemId) {
  const patchUrl = '/library/items/' + itemId + '/patch';
  return {
    saving: false,
    init() {
      this.$el.querySelectorAll('.ie').forEach(el => {
        el.addEventListener('click', () => this.activate(el));
      });
    },
    activate(el) {
      if (el.querySelector('.ie-input')) return; // already active
      const field = el.dataset.field;
      const type = el.dataset.type;
      const display = el.querySelector('.ie-display');
      const rawEl = el.querySelector('.ie-raw');
      const currentValue = rawEl ? rawEl.textContent : (display.classList.contains('muted') ? '' : display.textContent.trim());

      let input;
      if (type === 'textarea') {
        input = document.createElement('textarea');
        input.className = 'ie-input';
        input.rows = 3;
        input.style.fieldSizing = 'content';
        input.style.minHeight = '3rem';
        input.value = currentValue;
        input.addEventListener('blur', () => this.save(el, input));
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { this.deactivate(el, input); }
        });
      } else {
        input = document.createElement('input');
        input.type = el.dataset.inputType || 'text';
        input.className = 'ie-input';
        input.value = currentValue;
        input.addEventListener('blur', () => this.save(el, input));
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); this.save(el, input); }
          if (e.key === 'Escape') { this.deactivate(el, input); }
        });
      }

      display.style.display = 'none';
      el.appendChild(input);
      input.focus();
      if (input.select) input.select();
    },
    async save(el, input) {
      const field = el.dataset.field;
      const value = input.value;
      this.deactivate(el, input);

      el.classList.add('ie-saving');
      try {
        const res = await fetch(patchUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ field, value }),
        });
        const d = await res.json();
        if (!d.ok) {
          el.classList.add('ie-error');
          setTimeout(() => el.classList.remove('ie-error'), 2000);
          return;
        }
        // Update display
        const display = el.querySelector('.ie-display');
        const rawEl = el.querySelector('.ie-raw');
        if (field === 'default_price' && d.value != null) {
          display.textContent = '$' + Number(d.value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        } else {
          display.textContent = d.value || '\\u2014';
        }
        display.classList.toggle('muted', !d.value);
        if (rawEl) rawEl.textContent = d.value ?? '';

        el.classList.add('ie-saved');
        setTimeout(() => el.classList.remove('ie-saved'), 1200);
      } catch (err) {
        el.classList.add('ie-error');
        setTimeout(() => el.classList.remove('ie-error'), 2000);
      } finally {
        el.classList.remove('ie-saving');
      }
    },
    async toggleActive(checked) {
      try {
        const res = await fetch(patchUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ field: 'active', value: checked ? '1' : '0' }),
        });
        const d = await res.json();
        if (!d.ok) { alert(d.error || 'Error saving'); return; }
        // Refresh the page to update the status pill
        location.reload();
      } catch (err) {
        alert('Error saving active status');
      }
    },
    deactivate(el, input) {
      if (input && input.parentNode === el) el.removeChild(input);
      const display = el.querySelector('.ie-display');
      if (display) display.style.display = '';
    },
  };
}
`;
}
