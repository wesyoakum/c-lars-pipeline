// functions/settings/history.js
//
// GET /settings/history — admin-only audit log browser.
//
// Reads the existing audit_events table (migration 0001) and renders a
// paginated, filterable table. Filters: user, date range (from/to),
// entity_type, event_type, and free-text search on summary.
//
// Pagination is server-side (LIMIT/OFFSET) because the table can grow
// large and we don't want to ship every event to the client. Filter
// dropdowns for entity_type and event_type are populated from DISTINCT
// values in the table so new kinds of events show up automatically.

import { all, one } from '../lib/db.js';
import { layout, htmlResponse, html, escape, raw } from '../lib/layout.js';
import { readFlash } from '../lib/http.js';
import { hasRole } from '../lib/auth.js';
import { settingsSubNav } from '../lib/settings-subnav.js';
import { listScript, listTableHead, listToolbar, rowDataAttrs } from '../lib/list-table.js';

const PAGE_SIZE = 50;

// entity_type → detail-page URL. Only the entity types whose routes
// are addressable by a single id get links; nested entities (quote
// lines, price builds, etc.) show the id as plain text.
const ENTITY_HREF = {
  account:     (id) => `/accounts/${encodeURIComponent(id)}`,
  contact:     (id) => `/contacts/${encodeURIComponent(id)}`,
  opportunity: (id) => `/opportunities/${encodeURIComponent(id)}`,
  activity:    (id) => `/activities/${encodeURIComponent(id)}`,
  document:    (id) => `/documents/${encodeURIComponent(id)}`,
};

function shortId(id) {
  if (!id) return '';
  return id.length > 12 ? id.slice(0, 8) + '\u2026' : id;
}

function formatAt(iso) {
  if (!iso) return '';
  // Render as local yyyy-mm-dd hh:mm for scannability; tooltip shows
  // full ISO so second-level precision is still available on hover.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);

  if (!hasRole(user, 'admin')) {
    return htmlResponse(
      layout('History', `
        <section class="card">
          <h1>History</h1>
          <p>Admin role required to view this page.</p>
        </section>`,
        { user, env: data?.env, activeNav: '/settings' }),
      { status: 403 }
    );
  }

  const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  // Narrowing happens inside list-table's per-column filters + quicksearch;
  // the server just pages through everything in reverse-chrono order.
  const totalRow = await one(
    env.DB,
    `SELECT COUNT(*) AS n FROM audit_events`
  );
  const total = totalRow?.n ?? 0;

  const rows = await all(
    env.DB,
    `SELECT e.id, e.entity_type, e.entity_id, e.event_type, e.at,
            e.summary, e.changes_json, e.override_reason,
            e.user_id,
            u.email AS user_email, u.display_name AS user_name
       FROM audit_events e
       LEFT JOIN users u ON u.id = e.user_id
      ORDER BY e.at DESC, e.id DESC
      LIMIT ? OFFSET ?`,
    [PAGE_SIZE, offset]
  );

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Columns for the standard list-table renderer. All cells render
  // server-side; list-table adds per-column sort, filter, quicksearch,
  // and column show/hide/reorder on the current page only — the
  // server-side filter form above handles cross-page narrowing.
  const columns = [
    { key: 'when',        label: 'When',    sort: 'date',   filter: 'text',   default: true  },
    { key: 'user',        label: 'User',    sort: 'text',   filter: 'select', default: true  },
    { key: 'entity_type', label: 'Entity',  sort: 'text',   filter: 'select', default: true  },
    { key: 'entity_id',   label: 'Id',      sort: 'text',   filter: 'text',   default: false },
    { key: 'event_type',  label: 'Event',   sort: 'text',   filter: 'select', default: true  },
    { key: 'summary',     label: 'Summary', sort: 'text',   filter: 'text',   default: true  },
  ];

  // Shape rows for both data-attributes (sort/filter/quicksearch) and
  // display. `when_display` is the scannable yyyy-mm-dd hh:mm form;
  // `when` stays ISO so date-sort orders correctly.
  const rowData = rows.map((r) => ({
    id: r.id,
    when: r.at ?? '',
    when_display: formatAt(r.at),
    user: r.user_id ? (r.user_name || r.user_email || r.user_id) : 'system',
    entity_type: r.entity_type ?? '',
    entity_id: r.entity_id ?? '',
    entity_id_short: shortId(r.entity_id),
    event_type: r.event_type ?? '',
    summary: r.summary ?? '',
    changes_json: r.changes_json,
    override_reason: r.override_reason,
    is_system: !r.user_id,
  }));

  const pageHref = (n) =>
    '/settings/history' + (n > 1 ? `?page=${n}` : '');

  const body = html`
    ${settingsSubNav('history', true)}

    <section class="card">
      <div class="card-header">
        <h1>History</h1>
        ${listToolbar({ id: 'history', count: total, columns })}
      </div>

      <p class="muted">
        Every mutation in the app writes an audit row. Click a column
        header to sort or filter; use the search box to narrow the
        current page.
      </p>

      ${rowData.length === 0
        ? html`<p class="muted">No events yet.</p>`
        : html`
          <div class="opp-list" data-columns="${escape(JSON.stringify(columns))}">
            <table class="data opp-list-table">
              ${listTableHead(columns, rowData)}
              <tbody data-role="rows">
                ${rowData.map((r) => {
                  const hrefFn = ENTITY_HREF[r.entity_type];
                  return html`
                    <tr data-row-id="${escape(r.id)}"
                        ${raw(rowDataAttrs(columns, r))}>
                      <td class="col-when" data-col="when">
                        <small title="${escape(r.when)}">${escape(r.when_display)}</small>
                      </td>
                      <td class="col-user" data-col="user">
                        ${r.is_system
                          ? html`<small class="muted">system</small>`
                          : html`<small>${escape(r.user)}</small>`}
                      </td>
                      <td class="col-entity_type" data-col="entity_type">
                        <small>${escape(r.entity_type)}</small>
                      </td>
                      <td class="col-entity_id" data-col="entity_id">
                        ${hrefFn
                          ? html`<a href="${escape(hrefFn(r.entity_id))}"><code>${escape(r.entity_id_short)}</code></a>`
                          : html`<code>${escape(r.entity_id_short)}</code>`}
                      </td>
                      <td class="col-event_type" data-col="event_type">
                        <code>${escape(r.event_type)}</code>
                      </td>
                      <td class="col-summary" data-col="summary">
                        ${r.summary ? html`<div>${escape(r.summary)}</div>` : ''}
                        ${r.changes_json
                          ? html`<details style="margin-top:0.25rem">
                              <summary class="muted" style="font-size:0.85em;cursor:pointer">changes</summary>
                              <pre style="margin:0.25rem 0 0;font-size:0.8em;white-space:pre-wrap">${escape(prettyJson(r.changes_json))}</pre>
                            </details>`
                          : ''}
                        ${r.override_reason
                          ? html`<div class="muted" style="font-size:0.8em;margin-top:0.25rem">
                              override: ${escape(r.override_reason)}
                            </div>`
                          : ''}
                      </td>
                    </tr>`;
                })}
              </tbody>
            </table>
          </div>

          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:0.75rem">
            <span class="muted" style="font-size:0.85em">
              Page ${page} of ${pageCount} \u2022 showing ${rowData.length} of ${total}
            </span>
            <div style="display:flex;gap:0.5rem">
              ${page > 1
                ? html`<a class="btn" href="${escape(pageHref(page - 1))}">\u2190 Previous</a>`
                : html`<button class="btn" disabled>\u2190 Previous</button>`}
              ${page < pageCount
                ? html`<a class="btn" href="${escape(pageHref(page + 1))}">Next \u2192</a>`
                : html`<button class="btn" disabled>Next \u2192</button>`}
            </div>
          </div>
          <script>${raw(listScript('pipeline.history.v1', 'when', 'desc'))}</script>
        `}
    </section>
  `;

  return htmlResponse(
    layout('History', body, {
      user,
      env: data?.env,
      activeNav: '/settings',
      flash: readFlash(url),
      breadcrumbs: [
        { label: 'Settings', href: '/settings' },
        { label: 'History' },
      ],
    })
  );
}

function prettyJson(raw) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
