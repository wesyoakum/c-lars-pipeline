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

  // Read filter params from the query string.
  const qp = url.searchParams;
  const filters = {
    user_id:     (qp.get('user_id') || '').trim(),
    from:        (qp.get('from') || '').trim(),      // yyyy-mm-dd
    to:          (qp.get('to') || '').trim(),        // yyyy-mm-dd
    entity_type: (qp.get('entity_type') || '').trim(),
    event_type:  (qp.get('event_type') || '').trim(),
    q:           (qp.get('q') || '').trim(),
  };
  const page = Math.max(1, parseInt(qp.get('page'), 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  // Build the WHERE clause incrementally so we can re-use it for count
  // + page queries.
  const clauses = [];
  const params = [];
  if (filters.user_id) {
    clauses.push('e.user_id = ?');
    params.push(filters.user_id);
  }
  if (filters.from) {
    clauses.push('e.at >= ?');
    params.push(filters.from + 'T00:00:00Z');
  }
  if (filters.to) {
    // Inclusive end-of-day: add 24h so the filter captures everything
    // logged on the selected end date.
    clauses.push('e.at < ?');
    const d = new Date(filters.to + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    params.push(d.toISOString());
  }
  if (filters.entity_type) {
    clauses.push('e.entity_type = ?');
    params.push(filters.entity_type);
  }
  if (filters.event_type) {
    clauses.push('e.event_type = ?');
    params.push(filters.event_type);
  }
  if (filters.q) {
    clauses.push('e.summary LIKE ?');
    params.push('%' + filters.q + '%');
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

  // Total + page of rows.
  const totalRow = await one(
    env.DB,
    `SELECT COUNT(*) AS n FROM audit_events e ${where}`,
    params
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
       ${where}
      ORDER BY e.at DESC, e.id DESC
      LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, offset]
  );

  // Filter dropdown options. Distinct entity/event types straight from
  // the table so new types land here automatically.
  const entityTypes = await all(
    env.DB,
    `SELECT DISTINCT entity_type FROM audit_events ORDER BY entity_type`
  );
  const eventTypes = await all(
    env.DB,
    `SELECT DISTINCT event_type FROM audit_events ORDER BY event_type`
  );
  const users = await all(
    env.DB,
    `SELECT id, email, display_name FROM users ORDER BY email`
  );

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Preserve all current filters on the prev/next links.
  function pageHref(n) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v) p.set(k, v);
    }
    if (n > 1) p.set('page', String(n));
    const qs = p.toString();
    return '/settings/history' + (qs ? '?' + qs : '');
  }

  const body = html`
    ${settingsSubNav('history', true)}

    <section class="card">
      <div class="card-header">
        <h1>History</h1>
        <span class="muted" style="font-size:0.85em">${total} event${total === 1 ? '' : 's'}</span>
      </div>

      <p class="muted">
        Every mutation in the app writes an audit row. Filter by who,
        when, what kind of record, or search the summary text.
      </p>

      <form method="get" action="/settings/history" class="history-filters"
            style="display:flex;flex-wrap:wrap;gap:0.75rem;align-items:flex-end;margin-bottom:1rem">
        <label style="display:flex;flex-direction:column;gap:0.2rem">
          <span class="muted" style="font-size:0.8em">User</span>
          <select name="user_id" style="min-width:12rem">
            <option value="">(any)</option>
            ${users.map(u => html`
              <option value="${escape(u.id)}" ${filters.user_id === u.id ? raw('selected') : ''}>
                ${escape(u.display_name || u.email)}
              </option>
            `)}
          </select>
        </label>
        <label style="display:flex;flex-direction:column;gap:0.2rem">
          <span class="muted" style="font-size:0.8em">From</span>
          <input type="date" name="from" value="${escape(filters.from)}">
        </label>
        <label style="display:flex;flex-direction:column;gap:0.2rem">
          <span class="muted" style="font-size:0.8em">To</span>
          <input type="date" name="to" value="${escape(filters.to)}">
        </label>
        <label style="display:flex;flex-direction:column;gap:0.2rem">
          <span class="muted" style="font-size:0.8em">Entity type</span>
          <select name="entity_type">
            <option value="">(any)</option>
            ${entityTypes.map(r => html`
              <option value="${escape(r.entity_type)}" ${filters.entity_type === r.entity_type ? raw('selected') : ''}>
                ${escape(r.entity_type)}
              </option>
            `)}
          </select>
        </label>
        <label style="display:flex;flex-direction:column;gap:0.2rem">
          <span class="muted" style="font-size:0.8em">Event type</span>
          <select name="event_type">
            <option value="">(any)</option>
            ${eventTypes.map(r => html`
              <option value="${escape(r.event_type)}" ${filters.event_type === r.event_type ? raw('selected') : ''}>
                ${escape(r.event_type)}
              </option>
            `)}
          </select>
        </label>
        <label style="display:flex;flex-direction:column;gap:0.2rem;flex:1 1 12rem">
          <span class="muted" style="font-size:0.8em">Search summary</span>
          <input type="search" name="q" value="${escape(filters.q)}" placeholder="e.g. accepted">
        </label>
        <div style="display:flex;gap:0.5rem">
          <button type="submit" class="btn primary">Apply</button>
          <a class="btn" href="/settings/history">Reset</a>
        </div>
      </form>

      ${rows.length === 0
        ? html`<p class="muted">No events match these filters.</p>`
        : html`
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr>
                  <th>When</th>
                  <th>User</th>
                  <th>Entity</th>
                  <th>Event</th>
                  <th>Summary</th>
                </tr>
              </thead>
              <tbody>
                ${rows.map(r => {
                  const hrefFn = ENTITY_HREF[r.entity_type];
                  const entityCell = hrefFn
                    ? html`<a href="${escape(hrefFn(r.entity_id))}"><code>${escape(shortId(r.entity_id))}</code></a>`
                    : html`<code>${escape(shortId(r.entity_id))}</code>`;
                  return html`
                    <tr>
                      <td><small title="${escape(r.at || '')}">${escape(formatAt(r.at))}</small></td>
                      <td>${r.user_id
                        ? html`<small>${escape(r.user_name || r.user_email || r.user_id)}</small>`
                        : html`<small class="muted">system</small>`}</td>
                      <td>
                        <small class="muted">${escape(r.entity_type)}</small>
                        <br>${entityCell}
                      </td>
                      <td><code>${escape(r.event_type)}</code></td>
                      <td>
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
              Page ${page} of ${pageCount} \u2022 showing ${rows.length} of ${total}
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
