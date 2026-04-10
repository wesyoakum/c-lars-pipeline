// functions/opportunities/index.js
//
// GET  /opportunities   — list with filters (?q, ?type, ?stage, ?account)
// POST /opportunities   — create a new opportunity
//
// M3 keeps the list simple: one flat table, a few dropdown filters,
// and a full-text LIKE over title/number/description. Stage labels
// come from the stage_definitions table so adding a stage later
// doesn't require touching this route.

import { all, one, stmt, batch } from '../lib/db.js';
import { auditStmt } from '../lib/audit.js';
import { validateOpportunity, ENUMS } from '../lib/validators.js';
import { uuid, now, nextNumber, currentYear } from '../lib/ids.js';
import { layout, htmlResponse, html, raw, escape } from '../lib/layout.js';
import { redirectWithFlash, formBody, readFlash } from '../lib/http.js';
import { loadStageCatalog } from '../lib/stages.js';

const TYPE_LABELS = {
  spares: 'Spares',
  eps: 'Engineered Product (EPS)',
  refurb: 'Refurbishment',
  service: 'Service',
};

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);

  const q = (url.searchParams.get('q') || '').trim();
  const typeFilter = (url.searchParams.get('type') || '').trim();
  const stageFilter = (url.searchParams.get('stage') || '').trim();
  const accountFilter = (url.searchParams.get('account') || '').trim();

  // Build the WHERE clause dynamically. Keep it paranoid: only accept
  // known enum values so we never splice user input into SQL.
  const where = [];
  const params = [];
  if (q) {
    where.push('(o.title LIKE ? COLLATE NOCASE OR o.number LIKE ? COLLATE NOCASE OR o.description LIKE ? COLLATE NOCASE)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (typeFilter && ENUMS.TRANSACTION_TYPES.has(typeFilter)) {
    where.push('o.transaction_type = ?');
    params.push(typeFilter);
  }
  if (stageFilter) {
    where.push('o.stage = ?');
    params.push(stageFilter);
  }
  if (accountFilter) {
    where.push('o.account_id = ?');
    params.push(accountFilter);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = await all(
    env.DB,
    `SELECT o.id, o.number, o.title, o.transaction_type, o.stage,
            o.estimated_value_usd, o.probability, o.updated_at,
            o.expected_close_date,
            a.name AS account_name, a.id AS account_id
       FROM opportunities o
       LEFT JOIN accounts a ON a.id = o.account_id
       ${whereSql}
      ORDER BY o.updated_at DESC
      LIMIT 200`,
    params
  );

  // Pull stage catalog (for the filter dropdown) and accounts list (for
  // the account filter). Catalog is cached in lib/stages.js.
  const [catalog, accounts] = await Promise.all([
    loadStageCatalog(env.DB),
    all(env.DB, 'SELECT id, name FROM accounts ORDER BY name'),
  ]);

  // Flatten stage keys across all transaction types, de-duped, for the filter.
  // Sort order uses the spares catalog (all four share the same shared-early
  // stage sequence, with the same keys).
  const stageKeysSeen = new Map();
  for (const stages of catalog.values()) {
    for (const s of stages) {
      if (!stageKeysSeen.has(s.stage_key)) {
        stageKeysSeen.set(s.stage_key, { key: s.stage_key, label: s.label, sort_order: s.sort_order });
      }
    }
  }
  const stageOptions = Array.from(stageKeysSeen.values()).sort((a, b) => a.sort_order - b.sort_order);

  // Column catalog — label, key, filter type, default visibility. The
  // client-side controller lets the user toggle visibility, reorder,
  // sort, and filter per column, and persists the state to localStorage
  // under `pms.oppList.v1`. The table itself is server-rendered so the
  // page is useful even without JS.
  const columns = [
    { key: 'number',       label: 'Number',  sort: 'text',   filter: 'text',   default: true },
    { key: 'title',        label: 'Title',   sort: 'text',   filter: 'text',   default: true },
    { key: 'account_name', label: 'Account', sort: 'text',   filter: 'text',   default: true },
    { key: 'type_label',   label: 'Type',    sort: 'text',   filter: 'select', default: true },
    { key: 'stage_label',  label: 'Stage',   sort: 'text',   filter: 'select', default: true },
    { key: 'value',        label: 'Value',   sort: 'number', filter: 'range',  default: true },
    { key: 'close',        label: 'Close',   sort: 'date',   filter: 'text',   default: true },
    { key: 'updated',      label: 'Updated', sort: 'date',   filter: 'text',   default: false },
  ];

  // Shape rows once so each <tr> knows its sort/filter values and the
  // controller can read them off data- attributes without parsing text.
  const rowData = rows.map((r) => ({
    id: r.id,
    number: r.number ?? '',
    title: r.title ?? '',
    account_id: r.account_id ?? '',
    account_name: r.account_name ?? '',
    type_label: TYPE_LABELS[r.transaction_type] ?? r.transaction_type ?? '',
    stage_label: stageLabel(catalog, r.transaction_type, r.stage),
    value: r.estimated_value_usd == null ? '' : Number(r.estimated_value_usd),
    value_display:
      r.estimated_value_usd != null ? `$${formatMoney(r.estimated_value_usd)}` : '',
    close: r.expected_close_date ?? '',
    updated: (r.updated_at ?? '').slice(0, 10),
  }));

  const body = html`
    <section class="card">
      <div class="card-header">
        <h1>Opportunities</h1>
        <a class="btn primary" href="/opportunities/new">New opportunity</a>
      </div>

      <form method="get" action="/opportunities" class="inline-form">
        <input type="search" name="q" value="${escape(q)}"
               placeholder="Search title, number, description">
        <select name="type">
          <option value="">All types</option>
          ${Object.entries(TYPE_LABELS).map(
            ([k, label]) =>
              html`<option value="${k}" ${typeFilter === k ? 'selected' : ''}>${label}</option>`
          )}
        </select>
        <select name="stage">
          <option value="">All stages</option>
          ${stageOptions.map(
            (s) =>
              html`<option value="${s.key}" ${stageFilter === s.key ? 'selected' : ''}>${s.label}</option>`
          )}
        </select>
        <select name="account">
          <option value="">All accounts</option>
          ${accounts.map(
            (a) =>
              html`<option value="${escape(a.id)}" ${accountFilter === a.id ? 'selected' : ''}>${a.name}</option>`
          )}
        </select>
        <button class="btn" type="submit">Server filter</button>
        ${q || typeFilter || stageFilter || accountFilter
          ? html`<a class="btn" href="/opportunities">Clear</a>`
          : ''}
      </form>

      ${rows.length === 0
        ? html`<p class="muted">
            No opportunities match. Start by
            <a href="/opportunities/new">creating one</a>.
          </p>`
        : html`
          <div class="opp-list" data-columns="${escape(JSON.stringify(columns))}">
            <div class="opp-list-toolbar">
              <div class="opp-list-quicksearch">
                <input type="search" data-role="quicksearch"
                       placeholder="Quick search (all visible text columns)">
                <span class="muted" data-role="count">${rows.length} opportunities</span>
              </div>
              <details class="opp-list-columns" data-role="columns-menu">
                <summary class="btn btn-sm">Columns</summary>
                <div class="opp-list-columns-menu" data-role="columns-list">
                  <!-- populated by JS -->
                </div>
              </details>
            </div>
            <table class="data opp-list-table">
              <thead>
                <tr data-role="header-row">
                  ${columns.map(
                    (c) => html`
                      <th class="col-${c.key}" data-col="${c.key}">
                        <button type="button" class="col-sort" data-sort="${c.key}" data-sort-type="${c.sort}">
                          <span>${c.label}</span>
                          <span class="sort-indicator" data-role="sort-indicator"></span>
                        </button>
                      </th>`
                  )}
                </tr>
                <tr class="opp-list-filter-row" data-role="filter-row">
                  ${columns.map((c) => {
                    if (c.filter === 'text') {
                      return html`<th class="col-${c.key}" data-col="${c.key}"><input type="text" data-filter="${c.key}" data-filter-type="text" placeholder="Filter…"></th>`;
                    }
                    if (c.filter === 'select') {
                      const vals = Array.from(
                        new Set(rowData.map((r) => r[c.key]).filter((v) => v != null && v !== ''))
                      ).sort();
                      return html`<th class="col-${c.key}" data-col="${c.key}"><select data-filter="${c.key}" data-filter-type="select"><option value="">All</option>${vals.map((v) => html`<option value="${escape(v)}">${v}</option>`)}</select></th>`;
                    }
                    if (c.filter === 'range') {
                      return html`<th class="col-${c.key}" data-col="${c.key}"><div class="filter-range"><input type="number" data-filter="${c.key}" data-filter-type="min" placeholder="min"><input type="number" data-filter="${c.key}" data-filter-type="max" placeholder="max"></div></th>`;
                    }
                    return html`<th class="col-${c.key}" data-col="${c.key}"></th>`;
                  })}
                </tr>
              </thead>
              <tbody data-role="rows">
                ${rowData.map(
                  (r) => html`
                    <tr data-row-id="${escape(r.id)}"
                        data-number="${escape(r.number)}"
                        data-title="${escape(r.title)}"
                        data-account_name="${escape(r.account_name)}"
                        data-type_label="${escape(r.type_label)}"
                        data-stage_label="${escape(r.stage_label)}"
                        data-value="${escape(r.value === '' ? '' : String(r.value))}"
                        data-close="${escape(r.close)}"
                        data-updated="${escape(r.updated)}">
                      <td class="col-number" data-col="number"><code>${escape(r.number)}</code></td>
                      <td class="col-title" data-col="title">
                        <a href="/opportunities/${escape(r.id)}"><strong>${escape(r.title)}</strong></a>
                      </td>
                      <td class="col-account_name" data-col="account_name">
                        ${r.account_id
                          ? html`<a href="/accounts/${escape(r.account_id)}">${escape(r.account_name || '—')}</a>`
                          : html`<span class="muted">—</span>`}
                      </td>
                      <td class="col-type_label" data-col="type_label">${escape(r.type_label)}</td>
                      <td class="col-stage_label" data-col="stage_label">${escape(r.stage_label)}</td>
                      <td class="col-value" data-col="value">${escape(r.value_display)}</td>
                      <td class="col-close" data-col="close"><small class="muted">${escape(r.close)}</small></td>
                      <td class="col-updated" data-col="updated"><small class="muted">${escape(r.updated)}</small></td>
                    </tr>`
                )}
              </tbody>
            </table>
          </div>
          <script>${raw(oppListScript())}</script>
        `}
    </section>
  `;

  return htmlResponse(
    layout('Opportunities', body, {
      user,
      env: data?.env,
      activeNav: '/opportunities',
      flash: readFlash(url),
    })
  );
}

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const input = await formBody(request);

  const { ok, value, errors } = validateOpportunity(input);
  if (!ok) {
    const { renderNewForm } = await import('./new.js');
    return renderNewForm(context, { values: input, errors });
  }

  // Confirm account exists — cheap sanity check so an FK error doesn't
  // blow up mid-batch with a cryptic D1 error.
  const acct = await one(env.DB, 'SELECT id, name FROM accounts WHERE id = ?', [value.account_id]);
  if (!acct) {
    const { renderNewForm } = await import('./new.js');
    return renderNewForm(context, {
      values: input,
      errors: { account_id: 'Account not found' },
    });
  }

  const id = uuid();
  const ts = now();
  const number = await nextNumber(env.DB, `OPP-${currentYear()}`);

  // Default starting stage is 'lead'. Default probability copied from
  // the stage catalog so the UI has something sensible to show.
  const catalog = await loadStageCatalog(env.DB);
  const typeStages = catalog.get(value.transaction_type) ?? [];
  const leadStage = typeStages.find((s) => s.stage_key === 'lead');
  const probability = leadStage?.default_probability ?? 0;

  await batch(env.DB, [
    stmt(
      env.DB,
      `INSERT INTO opportunities
         (id, number, account_id, primary_contact_id, title, description,
          transaction_type, stage, stage_entered_at, probability,
          estimated_value_usd, currency, expected_close_date,
          rfq_format, bant_budget, bant_authority, bant_authority_contact_id,
          bant_need, bant_timeline,
          owner_user_id, salesperson_user_id,
          created_at, updated_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        number,
        value.account_id,
        value.primary_contact_id,
        value.title,
        value.description,
        value.transaction_type,
        'lead',
        ts,
        probability,
        value.estimated_value_usd,
        'USD',
        value.expected_close_date,
        value.rfq_format,
        value.bant_budget,
        value.bant_authority,
        value.bant_authority_contact_id,
        value.bant_need,
        value.bant_timeline,
        value.owner_user_id ?? user?.id ?? null,
        value.salesperson_user_id ?? user?.id ?? null,
        ts,
        ts,
        user?.id ?? null,
      ]
    ),
    auditStmt(env.DB, {
      entityType: 'opportunity',
      entityId: id,
      eventType: 'created',
      user,
      summary: `Created ${number}: "${value.title}" for ${acct.name}`,
      changes: {
        ...value,
        number,
        stage: 'lead',
      },
    }),
  ]);

  return redirectWithFlash(
    `/opportunities/${id}`,
    `Opportunity ${number} created.`
  );
}

// -- helpers ---------------------------------------------------------------

function stageLabel(catalog, txType, stageKey) {
  const list = catalog.get(txType) ?? [];
  const def = list.find((s) => s.stage_key === stageKey);
  return def?.label ?? stageKey;
}

function formatMoney(n) {
  // Keep it boring: integer US dollars with thousands separators.
  return Math.round(Number(n)).toLocaleString('en-US');
}

/**
 * Client-side controller for the opportunities table. The table itself is
 * server-rendered (so the page is useful without JS), and this script
 * progressively enhances it with:
 *   - per-column sort (click a column header)
 *   - per-column filter (text / select / numeric range)
 *   - quick text search across visible columns
 *   - column visibility toggling + reordering
 *   - localStorage persistence of column state + sort under `pms.oppList.v1`
 *
 * Plain vanilla JS on purpose — Alpine's nested <template> handling in
 * tables had rendering issues, and the imperative DOM approach here is
 * simpler and degrades gracefully.
 */
export function oppListScript() {
  return `
(function() {
  var STORAGE_KEY = 'pms.oppList.v1';
  var host = document.querySelector('.opp-list');
  if (!host) return;

  var columns = [];
  try { columns = JSON.parse(host.dataset.columns || '[]'); } catch (e) {}
  if (!columns.length) return;

  var tbody = host.querySelector('[data-role="rows"]');
  var allRows = Array.prototype.slice.call(tbody.querySelectorAll('tr[data-row-id]'));
  var totalRows = allRows.length;
  var countEl = host.querySelector('[data-role="count"]');
  var quickSearchInput = host.querySelector('[data-role="quicksearch"]');
  var columnsListEl = host.querySelector('[data-role="columns-list"]');

  // State: column visibility + order + sort. Filters are read directly
  // from the filter input DOM each time we re-apply.
  var state = {
    columns: columns.map(function(c) { return { key: c.key, visible: c.default !== false }; }),
    sort: { key: 'updated', dir: 'desc' },
  };

  // Merge saved state (if any) onto the server-provided catalog so newly
  // added columns show up for existing users without nuking preferences.
  try {
    var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && Array.isArray(saved.columns)) {
      var byKey = {};
      state.columns.forEach(function(c) { byKey[c.key] = c; });
      var merged = [];
      var seen = {};
      saved.columns.forEach(function(s) {
        if (byKey[s.key]) {
          merged.push({ key: s.key, visible: !!s.visible });
          seen[s.key] = true;
        }
      });
      state.columns.forEach(function(c) {
        if (!seen[c.key]) merged.push(c);
      });
      state.columns = merged;
      if (saved.sort && saved.sort.key) state.sort = saved.sort;
    }
  } catch (e) {}

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {}
  }

  function columnMeta(key) {
    for (var i = 0; i < columns.length; i++) {
      if (columns[i].key === key) return columns[i];
    }
    return null;
  }

  // -- Column visibility + reordering ------------------------------------

  function applyColumnVisibility() {
    state.columns.forEach(function(c) {
      var hide = !c.visible;
      host.querySelectorAll('[data-col="' + c.key + '"]').forEach(function(el) {
        el.style.display = hide ? 'none' : '';
      });
    });
  }

  function applyColumnOrder() {
    // Reorder header cells, filter cells, and each row's <td>s to match
    // state.columns. We walk each parent row and re-append children in
    // the desired sequence — appendChild moves nodes.
    var parents = [
      host.querySelector('[data-role="header-row"]'),
      host.querySelector('[data-role="filter-row"]'),
    ].concat(allRows);

    parents.forEach(function(parent) {
      if (!parent) return;
      state.columns.forEach(function(c) {
        var cell = parent.querySelector('[data-col="' + c.key + '"]');
        if (cell) parent.appendChild(cell);
      });
    });
  }

  function renderColumnMenu() {
    columnsListEl.innerHTML = '';
    state.columns.forEach(function(c, idx) {
      var meta = columnMeta(c.key);
      if (!meta) return;
      var row = document.createElement('div');
      row.className = 'opp-list-column-row';

      var label = document.createElement('label');
      label.className = 'checkbox';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!c.visible;
      cb.addEventListener('change', function() {
        c.visible = cb.checked;
        applyColumnVisibility();
        save();
      });
      var span = document.createElement('span');
      span.textContent = meta.label;
      label.appendChild(cb);
      label.appendChild(span);
      row.appendChild(label);

      var moveBox = document.createElement('div');
      moveBox.className = 'opp-list-column-move';
      var up = document.createElement('button');
      up.type = 'button';
      up.className = 'btn btn-xs';
      up.textContent = '\\u2191';
      up.disabled = idx === 0;
      up.addEventListener('click', function() { moveColumn(idx, -1); });
      var down = document.createElement('button');
      down.type = 'button';
      down.className = 'btn btn-xs';
      down.textContent = '\\u2193';
      down.disabled = idx === state.columns.length - 1;
      down.addEventListener('click', function() { moveColumn(idx, 1); });
      moveBox.appendChild(up);
      moveBox.appendChild(down);
      row.appendChild(moveBox);

      columnsListEl.appendChild(row);
    });

    var actions = document.createElement('div');
    actions.className = 'opp-list-columns-actions';
    var reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'btn btn-xs';
    reset.textContent = 'Reset';
    reset.addEventListener('click', function() {
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
      location.reload();
    });
    actions.appendChild(reset);
    columnsListEl.appendChild(actions);
  }

  function moveColumn(idx, delta) {
    var j = idx + delta;
    if (j < 0 || j >= state.columns.length) return;
    var item = state.columns.splice(idx, 1)[0];
    state.columns.splice(j, 0, item);
    applyColumnOrder();
    renderColumnMenu();
    save();
  }

  // -- Filtering + quick search -----------------------------------------

  function rowMatches(tr) {
    var data = tr.dataset;

    // Quick search across visible text columns.
    var qs = (quickSearchInput && quickSearchInput.value || '').trim().toLowerCase();
    if (qs) {
      var hit = false;
      for (var i = 0; i < state.columns.length; i++) {
        var c = state.columns[i];
        if (!c.visible) continue;
        var v = data[c.key];
        if (v != null && String(v).toLowerCase().indexOf(qs) !== -1) {
          hit = true;
          break;
        }
      }
      if (!hit) return false;
    }

    // Per-column filters.
    for (var k = 0; k < columns.length; k++) {
      var col = columns[k];
      if (col.filter === 'text') {
        var input = host.querySelector('input[data-filter="' + col.key + '"][data-filter-type="text"]');
        if (!input) continue;
        var f = input.value.trim().toLowerCase();
        if (!f) continue;
        var v2 = data[col.key];
        if (v2 == null || String(v2).toLowerCase().indexOf(f) === -1) return false;
      } else if (col.filter === 'select') {
        var sel = host.querySelector('select[data-filter="' + col.key + '"]');
        if (!sel) continue;
        var sv = sel.value;
        if (!sv) continue;
        if (String(data[col.key] || '') !== String(sv)) return false;
      } else if (col.filter === 'range') {
        var minI = host.querySelector('input[data-filter="' + col.key + '"][data-filter-type="min"]');
        var maxI = host.querySelector('input[data-filter="' + col.key + '"][data-filter-type="max"]');
        var rv = data[col.key];
        if (minI && minI.value !== '' && (rv === '' || Number(rv) < Number(minI.value))) return false;
        if (maxI && maxI.value !== '' && (rv === '' || Number(rv) > Number(maxI.value))) return false;
      }
    }
    return true;
  }

  function applyFilters() {
    var shown = 0;
    allRows.forEach(function(tr) {
      var match = rowMatches(tr);
      tr.style.display = match ? '' : 'none';
      if (match) shown++;
    });
    if (countEl) {
      countEl.textContent = 'Showing ' + shown + ' of ' + totalRows;
    }
  }

  // -- Sorting ----------------------------------------------------------

  function applySort() {
    var key = state.sort.key;
    var dir = state.sort.dir === 'asc' ? 1 : -1;
    var meta = columnMeta(key);
    var type = meta ? meta.sort : 'text';

    var sorted = allRows.slice();
    sorted.sort(function(a, b) {
      var av = a.dataset[key];
      var bv = b.dataset[key];
      if (av == null || av === '') av = null;
      if (bv == null || bv === '') bv = null;
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (type === 'number') return (Number(av) - Number(bv)) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    var frag = document.createDocumentFragment();
    sorted.forEach(function(tr) { frag.appendChild(tr); });
    tbody.appendChild(frag);
  }

  function updateSortIndicators() {
    host.querySelectorAll('[data-role="sort-indicator"]').forEach(function(el) {
      el.textContent = '';
    });
    var th = host.querySelector('[data-sort="' + state.sort.key + '"]');
    if (th) {
      var ind = th.querySelector('[data-role="sort-indicator"]');
      if (ind) ind.textContent = state.sort.dir === 'asc' ? '\\u25B2' : '\\u25BC';
    }
  }

  // -- Wire it all up ---------------------------------------------------

  // Sort on column header click.
  host.querySelectorAll('[data-sort]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var key = btn.dataset.sort;
      if (state.sort.key === key) {
        state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sort = { key: key, dir: 'asc' };
      }
      updateSortIndicators();
      applySort();
      save();
    });
  });

  // Filter inputs.
  host.querySelectorAll('[data-filter]').forEach(function(input) {
    var ev = input.tagName === 'SELECT' ? 'change' : 'input';
    input.addEventListener(ev, applyFilters);
  });

  // Quick search.
  if (quickSearchInput) {
    quickSearchInput.addEventListener('input', applyFilters);
  }

  renderColumnMenu();
  applyColumnOrder();
  applyColumnVisibility();
  updateSortIndicators();
  applySort();
  applyFilters();
})();
`;
}
