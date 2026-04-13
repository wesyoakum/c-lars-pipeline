// functions/jobs/index.js
//
// GET  /jobs   — list all jobs with filters
// POST /jobs   — create a new job (typically auto-created from stage transition)

import { all, one, stmt, batch } from '../lib/db.js';
import { auditStmt } from '../lib/audit.js';
import { uuid, now, nextNumber, currentYear } from '../lib/ids.js';
import { layout, htmlResponse, html, raw, escape } from '../lib/layout.js';
import { redirectWithFlash, formBody, readFlash } from '../lib/http.js';
import { parseTransactionTypes } from '../lib/validators.js';

const TYPE_LABELS = {
  spares: 'Spares',
  eps: 'Engineered Product (EPS)',
  refurb: 'Refurbishment',
  service: 'Service',
};

const STATUS_LABELS = {
  created: 'Created',
  awaiting_authorization: 'Awaiting Authorization',
  awaiting_ntp: 'Awaiting NTP',
  handed_off: 'Handed Off',
  cancelled: 'Cancelled',
};

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);

  const rows = await all(
    env.DB,
    `SELECT j.id, j.number, j.title, j.job_type, j.status,
            j.oc_number, j.ntp_required,
            j.handed_off_at, j.created_at, j.updated_at,
            o.number AS opp_number, o.title AS opp_title, o.id AS opp_id,
            a.name AS account_name
       FROM jobs j
       LEFT JOIN opportunities o ON o.id = j.opportunity_id
       LEFT JOIN accounts a ON a.id = o.account_id
      ORDER BY j.updated_at DESC
      LIMIT 500`
  );

  const columns = [
    { key: 'number',       label: 'Job #',    sort: 'text',   filter: 'text',   default: true },
    { key: 'title',        label: 'Title',    sort: 'text',   filter: 'text',   default: true },
    { key: 'account_name', label: 'Account',  sort: 'text',   filter: 'text',   default: true },
    { key: 'opp_number',   label: 'Opp #',    sort: 'text',   filter: 'text',   default: true },
    { key: 'type_label',   label: 'Type',     sort: 'text',   filter: 'select', default: true },
    { key: 'status_label', label: 'Status',   sort: 'text',   filter: 'select', default: true },
    { key: 'oc_number',    label: 'OC #',     sort: 'text',   filter: 'text',   default: true },
    { key: 'updated',      label: 'Updated',  sort: 'date',   filter: 'text',   default: true },
  ];

  const rowData = rows.map(r => ({
    id: r.id,
    number: r.number ?? '',
    title: r.title ?? '',
    account_name: r.account_name ?? '',
    opp_number: r.opp_number ?? '',
    opp_id: r.opp_id ?? '',
    type_label: parseTransactionTypes(r.job_type).map(t => TYPE_LABELS[t] ?? t).join(', ') || r.job_type || '—',
    status_label: STATUS_LABELS[r.status] ?? r.status ?? '',
    oc_number: r.oc_number ?? '',
    updated: (r.updated_at ?? '').slice(0, 10),
  }));

  const body = html`
    <section class="card">
      <div class="card-header">
        <h1 class="page-title">Jobs</h1>
        <div class="toolbar-right">
          <div class="search-expand">
            <label class="search-icon" for="job-quicksearch">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8.5" cy="8.5" r="5.5"/><line x1="13" y1="13" x2="18" y2="18"/></svg>
            </label>
            <input type="search" id="job-quicksearch" data-role="quicksearch" placeholder="Search...">
          </div>
          <span class="muted" data-role="count" style="font-size:0.8em;white-space:nowrap">${rows.length}</span>
          <details class="opp-list-columns" data-role="columns-menu" style="display:inline-block">
            <summary class="icon-btn" title="Columns">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="4" x2="17" y2="4"/><line x1="3" y1="10" x2="17" y2="10"/><line x1="3" y1="16" x2="17" y2="16"/></svg>
            </summary>
          </details>
        </div>
      </div>

      ${rows.length === 0
        ? html`<p class="muted">No jobs yet. Jobs are created when an opportunity reaches Closed Won.</p>`
        : html`
          <div class="opp-list" data-columns="${escape(JSON.stringify(columns))}">
            <div class="opp-list-toolbar" style="display:none"></div>
            <table class="data opp-list-table">
              <thead>
                <tr data-role="header-row">
                  ${columns.map(c => html`
                    <th class="col-${c.key}" data-col="${c.key}">
                      <button type="button" class="col-sort" data-sort="${c.key}" data-sort-type="${c.sort}">
                        <span>${c.label}</span>
                        <span class="sort-indicator" data-role="sort-indicator"></span>
                      </button>
                    </th>`)}
                </tr>
                <tr class="opp-list-filter-row filters-hidden" data-role="filter-row">
                  ${columns.map(c => {
                    if (c.filter === 'select') {
                      const vals = Array.from(new Set(rowData.map(r => r[c.key]).filter(v => v))).sort();
                      return html`<th class="col-${c.key}" data-col="${c.key}"><select data-filter="${c.key}" data-filter-type="select"><option value="">All</option>${vals.map(v => html`<option value="${escape(v)}">${v}</option>`)}</select></th>`;
                    }
                    return html`<th class="col-${c.key}" data-col="${c.key}"><input type="text" data-filter="${c.key}" data-filter-type="text" placeholder="Filter..."></th>`;
                  })}
                </tr>
              </thead>
              <tbody data-role="rows">
                ${rowData.map(r => html`
                  <tr data-row-id="${escape(r.id)}"
                      ${columns.map(c => `data-${c.key}="${escape(r[c.key])}"`).join(' ')}>
                    <td class="col-number" data-col="number"><a href="/jobs/${escape(r.id)}"><strong>${escape(r.number)}</strong></a></td>
                    <td class="col-title" data-col="title">${escape(r.title)}</td>
                    <td class="col-account_name" data-col="account_name">${r.opp_id ? html`<a href="/opportunities/${escape(r.opp_id)}">${escape(r.account_name)}</a>` : escape(r.account_name)}</td>
                    <td class="col-opp_number" data-col="opp_number">${r.opp_id ? html`<a href="/opportunities/${escape(r.opp_id)}">${escape(r.opp_number)}</a>` : escape(r.opp_number)}</td>
                    <td class="col-type_label" data-col="type_label">${escape(r.type_label)}</td>
                    <td class="col-status_label" data-col="status_label"><span class="pill ${r.status_label === 'Handed Off' ? 'pill-green' : r.status_label === 'Cancelled' ? 'pill-red' : ''}">${escape(r.status_label)}</span></td>
                    <td class="col-oc_number" data-col="oc_number">${escape(r.oc_number)}</td>
                    <td class="col-updated" data-col="updated"><small class="muted">${escape(r.updated)}</small></td>
                  </tr>`)}
              </tbody>
            </table>
          </div>`}
    </section>
    ${raw(listScript())}`;

  return htmlResponse(
    layout('Jobs', body, {
      user,
      env: data?.env,
      activeNav: '/jobs',
      flash: readFlash(url),
      breadcrumbs: [{ label: 'Jobs' }],
    })
  );
}

function listScript() {
  return `<script>
(function(){
  const wrap = document.querySelector('.opp-list');
  if (!wrap) return;
  const table = wrap.querySelector('.opp-list-table');
  const tbody = table.querySelector('[data-role="rows"]');
  const quicksearch = document.querySelector('[data-role="quicksearch"]');
  const countEl = document.querySelector('[data-role="count"]');
  const filterRow = table.querySelector('[data-role="filter-row"]');
  const headerRow = table.querySelector('[data-role="header-row"]');
  const columns = JSON.parse(wrap.dataset.columns);

  // Show filter row
  if (filterRow) filterRow.classList.remove('filters-hidden');

  // Quick search
  if (quicksearch) {
    quicksearch.addEventListener('input', applyFilters);
  }

  // Column filters
  filterRow.querySelectorAll('[data-filter]').forEach(el => {
    el.addEventListener('input', applyFilters);
    el.addEventListener('change', applyFilters);
  });

  // Sorting
  headerRow.querySelectorAll('[data-sort]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.sort;
      const type = btn.dataset.sortType;
      const current = btn.dataset.dir || '';
      const dir = current === 'asc' ? 'desc' : 'asc';
      headerRow.querySelectorAll('[data-sort]').forEach(b => { b.dataset.dir = ''; b.querySelector('[data-role="sort-indicator"]').textContent = ''; });
      btn.dataset.dir = dir;
      btn.querySelector('[data-role="sort-indicator"]').textContent = dir === 'asc' ? ' ↑' : ' ↓';
      sortRows(key, type, dir);
    });
  });

  function applyFilters() {
    const q = (quicksearch?.value || '').toLowerCase();
    const filters = {};
    filterRow.querySelectorAll('[data-filter]').forEach(el => {
      const key = el.dataset.filter;
      const val = el.value.trim().toLowerCase();
      if (val) filters[key] = val;
    });
    let visible = 0;
    tbody.querySelectorAll('tr').forEach(tr => {
      const text = tr.textContent.toLowerCase();
      let show = !q || text.includes(q);
      if (show) {
        for (const [key, val] of Object.entries(filters)) {
          const cell = (tr.dataset[key] || '').toLowerCase();
          if (!cell.includes(val)) { show = false; break; }
        }
      }
      tr.style.display = show ? '' : 'none';
      if (show) visible++;
    });
    if (countEl) countEl.textContent = visible;
  }

  function sortRows(key, type, dir) {
    const rows = Array.from(tbody.querySelectorAll('tr'));
    rows.sort((a, b) => {
      let va = a.dataset[key] || '';
      let vb = b.dataset[key] || '';
      if (type === 'date') { va = va || '9999'; vb = vb || '9999'; }
      const cmp = va.localeCompare(vb, undefined, { numeric: true, sensitivity: 'base' });
      return dir === 'asc' ? cmp : -cmp;
    });
    rows.forEach(r => tbody.appendChild(r));
  }
})();
</script>`;
}
