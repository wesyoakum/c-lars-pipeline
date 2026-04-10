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

  // Build the row payload for the Alpine list. We shape it here once so
  // the client never has to know about stage_definitions / TYPE_LABELS.
  const rowPayload = rows.map((r) => ({
    id: r.id,
    number: r.number ?? '',
    title: r.title ?? '',
    account_id: r.account_id ?? '',
    account_name: r.account_name ?? '',
    type: r.transaction_type ?? '',
    type_label: TYPE_LABELS[r.transaction_type] ?? r.transaction_type ?? '',
    stage: r.stage ?? '',
    stage_label: stageLabel(catalog, r.transaction_type, r.stage),
    value: r.estimated_value_usd == null ? null : Number(r.estimated_value_usd),
    value_display:
      r.estimated_value_usd != null ? `$${formatMoney(r.estimated_value_usd)}` : '',
    close: r.expected_close_date ?? '',
    updated: (r.updated_at ?? '').slice(0, 10),
  }));

  // Column catalog — label, data key, type, default visibility. The Alpine
  // component lets the user toggle visibility, reorder (via up/down), sort,
  // and filter per column, and persists the state to localStorage under
  // `pms.oppList.v1`.
  const columns = [
    { key: 'number',       label: 'Number',  type: 'text',   sortable: true, filter: 'text',   default: true },
    { key: 'title',        label: 'Title',   type: 'text',   sortable: true, filter: 'text',   default: true },
    { key: 'account_name', label: 'Account', type: 'text',   sortable: true, filter: 'text',   default: true },
    { key: 'type_label',   label: 'Type',    type: 'enum',   sortable: true, filter: 'select', default: true, enumKey: 'type' },
    { key: 'stage_label',  label: 'Stage',   type: 'enum',   sortable: true, filter: 'select', default: true, enumKey: 'stage' },
    { key: 'value',        label: 'Value',   type: 'number', sortable: true, filter: 'range',  default: true, displayKey: 'value_display' },
    { key: 'close',        label: 'Close',   type: 'date',   sortable: true, filter: 'text',   default: true },
    { key: 'updated',      label: 'Updated', type: 'date',   sortable: true, filter: 'text',   default: false },
  ];

  const initialState = JSON.stringify({
    rows: rowPayload,
    columns,
  });

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
          <div class="opp-list" x-data="pmsOppList()" data-initial="${escape(initialState)}">
            <div class="opp-list-toolbar">
              <div class="opp-list-quicksearch">
                <input type="search" x-model="quickSearch"
                       placeholder="Quick search (all visible text columns)">
                <span class="muted" x-text="'Showing ' + filteredRows.length + ' of ' + rows.length"></span>
              </div>
              <details class="opp-list-columns">
                <summary class="btn btn-sm">Columns</summary>
                <div class="opp-list-columns-menu">
                  <template x-for="(col, idx) in columns" :key="col.key">
                    <div class="opp-list-column-row">
                      <label class="checkbox">
                        <input type="checkbox" x-model="col.visible">
                        <span x-text="col.label"></span>
                      </label>
                      <div class="opp-list-column-move">
                        <button type="button" class="btn btn-xs" @click="moveColumn(idx, -1)" :disabled="idx === 0">↑</button>
                        <button type="button" class="btn btn-xs" @click="moveColumn(idx, 1)" :disabled="idx === columns.length - 1">↓</button>
                      </div>
                    </div>
                  </template>
                  <div class="opp-list-columns-actions">
                    <button type="button" class="btn btn-xs" @click="resetState()">Reset</button>
                  </div>
                </div>
              </details>
            </div>
            <table class="data opp-list-table">
              <thead>
                <tr>
                  <template x-for="col in visibleColumns" :key="col.key">
                    <th :class="'col-' + col.key">
                      <button type="button" class="col-sort" @click="toggleSort(col.key)">
                        <span x-text="col.label"></span>
                        <span class="sort-indicator"
                              x-text="sort.key === col.key ? (sort.dir === 'asc' ? '▲' : '▼') : ''"></span>
                      </button>
                    </th>
                  </template>
                </tr>
                <tr class="opp-list-filter-row">
                  <template x-for="col in visibleColumns" :key="col.key">
                    <th :class="'col-' + col.key + ' filter-cell'">
                      <template x-if="col.filter === 'text'">
                        <input type="text" x-model="filters[col.key]" placeholder="Filter…">
                      </template>
                      <template x-if="col.filter === 'select'">
                        <select x-model="filters[col.key]">
                          <option value="">All</option>
                          <template x-for="opt in enumOptions(col)" :key="opt">
                            <option :value="opt" x-text="opt"></option>
                          </template>
                        </select>
                      </template>
                      <template x-if="col.filter === 'range'">
                        <div class="filter-range">
                          <input type="number" x-model="filters[col.key + '__min']" placeholder="min">
                          <input type="number" x-model="filters[col.key + '__max']" placeholder="max">
                        </div>
                      </template>
                    </th>
                  </template>
                </tr>
              </thead>
              <tbody>
                <template x-for="row in filteredRows" :key="row.id">
                  <tr>
                    <template x-for="col in visibleColumns" :key="col.key">
                      <td :class="'col-' + col.key">
                        <template x-if="col.key === 'number'">
                          <code x-text="row.number"></code>
                        </template>
                        <template x-if="col.key === 'title'">
                          <a :href="'/opportunities/' + row.id"><strong x-text="row.title"></strong></a>
                        </template>
                        <template x-if="col.key === 'account_name'">
                          <template x-if="row.account_id">
                            <a :href="'/accounts/' + row.account_id" x-text="row.account_name || '—'"></a>
                          </template>
                          <template x-if="!row.account_id">
                            <span class="muted">—</span>
                          </template>
                        </template>
                        <template x-if="col.key === 'type_label'">
                          <span x-text="row.type_label"></span>
                        </template>
                        <template x-if="col.key === 'stage_label'">
                          <span x-text="row.stage_label"></span>
                        </template>
                        <template x-if="col.key === 'value'">
                          <span x-text="row.value_display"></span>
                        </template>
                        <template x-if="col.key === 'close'">
                          <small class="muted" x-text="row.close"></small>
                        </template>
                        <template x-if="col.key === 'updated'">
                          <small class="muted" x-text="row.updated"></small>
                        </template>
                      </td>
                    </template>
                  </tr>
                </template>
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
 * Client-side Alpine component for the opportunities table: column
 * show/hide + reordering, per-column filter, sort-any-column, quick text
 * search. Persists column visibility + order + sort to localStorage under
 * `pms.oppList.v1` so user preferences survive navigations.
 *
 * The server embeds the rows + column catalog in a `data-initial` JSON
 * attribute on the host element rather than inlining JSON into the x-data
 * expression — the escaping gets hairy when JSON contains `"` characters.
 */
export function oppListScript() {
  return `
(function() {
  const STORAGE_KEY = 'pms.oppList.v1';

  function loadSaved() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  function pmsOppList() {
    return {
      rows: [],
      columns: [],
      sort: { key: 'updated', dir: 'desc' },
      filters: {},
      quickSearch: '',

      init() {
        let initial = { rows: [], columns: [] };
        try {
          const raw = this.$el.dataset.initial || '{}';
          initial = JSON.parse(raw) || { rows: [], columns: [] };
        } catch (e) {}
        this.rows = initial.rows || [];

        // Server-provided column catalog; merge with any saved state so
        // new columns added to the server defaults show up for existing
        // users without wiping their preferences.
        const base = (initial.columns || []).map((c) => ({
          ...c,
          visible: c.default !== false,
        }));
        const saved = loadSaved();
        if (saved && Array.isArray(saved.columns)) {
          const byKey = new Map(base.map((c) => [c.key, c]));
          const merged = [];
          const seen = new Set();
          for (const s of saved.columns) {
            const match = byKey.get(s.key);
            if (match) {
              merged.push({ ...match, visible: !!s.visible });
              seen.add(s.key);
            }
          }
          for (const c of base) {
            if (!seen.has(c.key)) merged.push(c);
          }
          this.columns = merged;
          if (saved.sort && saved.sort.key) this.sort = saved.sort;
        } else {
          this.columns = base;
        }

        // Watch for state changes and persist.
        this.$watch('columns', () => this.save(), { deep: true });
        this.$watch('sort', () => this.save(), { deep: true });
      },

      save() {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({
            columns: this.columns.map((c) => ({ key: c.key, visible: !!c.visible })),
            sort: this.sort,
          }));
        } catch (e) {}
      },

      resetState() {
        try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
        location.reload();
      },

      get visibleColumns() {
        return this.columns.filter((c) => c.visible);
      },

      moveColumn(idx, delta) {
        const j = idx + delta;
        if (j < 0 || j >= this.columns.length) return;
        const copy = this.columns.slice();
        const [item] = copy.splice(idx, 1);
        copy.splice(j, 0, item);
        this.columns = copy;
      },

      toggleSort(key) {
        if (this.sort.key === key) {
          this.sort = { key, dir: this.sort.dir === 'asc' ? 'desc' : 'asc' };
        } else {
          this.sort = { key, dir: 'asc' };
        }
      },

      enumOptions(col) {
        const key = col.key;
        const seen = new Set();
        for (const r of this.rows) {
          const v = r[key];
          if (v != null && v !== '') seen.add(String(v));
        }
        return Array.from(seen).sort();
      },

      rowMatches(row) {
        // Quick search across all visible text columns.
        if (this.quickSearch && this.quickSearch.trim()) {
          const needle = this.quickSearch.trim().toLowerCase();
          const hit = this.visibleColumns.some((c) => {
            const v = row[c.key];
            return v != null && String(v).toLowerCase().indexOf(needle) !== -1;
          });
          if (!hit) return false;
        }
        // Per-column filters.
        for (const col of this.columns) {
          if (col.filter === 'text') {
            const f = (this.filters[col.key] || '').trim().toLowerCase();
            if (!f) continue;
            const v = row[col.key];
            if (v == null || String(v).toLowerCase().indexOf(f) === -1) return false;
          } else if (col.filter === 'select') {
            const f = this.filters[col.key];
            if (!f) continue;
            if (String(row[col.key]) !== String(f)) return false;
          } else if (col.filter === 'range') {
            const min = this.filters[col.key + '__min'];
            const max = this.filters[col.key + '__max'];
            const v = row[col.key];
            if (min !== undefined && min !== '' && (v == null || Number(v) < Number(min))) return false;
            if (max !== undefined && max !== '' && (v == null || Number(v) > Number(max))) return false;
          }
        }
        return true;
      },

      get filteredRows() {
        const out = this.rows.filter((r) => this.rowMatches(r));
        const key = this.sort.key;
        const dir = this.sort.dir === 'asc' ? 1 : -1;
        out.sort((a, b) => {
          const av = a[key];
          const bv = b[key];
          if (av == null && bv == null) return 0;
          if (av == null) return 1;
          if (bv == null) return -1;
          if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
          return String(av).localeCompare(String(bv)) * dir;
        });
        return out;
      },
    };
  }

  window.pmsOppList = pmsOppList;
  document.addEventListener('alpine:init', function() {
    if (window.Alpine && window.Alpine.data) {
      window.Alpine.data('pmsOppList', pmsOppList);
    }
  });
})();
`;
}
