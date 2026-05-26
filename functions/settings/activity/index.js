// functions/settings/activity/index.js
//
// GET /settings/activity — admin-only user activity dashboard.
//
// Three tabs:
//   Timeline  — chronological feed of audit_events + page views
//   By user   — per-user activity summary (sessions, last seen, top entities)
//   Adoption  — active user counts, sessions/day, page views chart

import { all, one } from '../../lib/db.js';
import { layout, htmlResponse, html, escape, raw } from '../../lib/layout.js';
import { hasRole } from '../../lib/auth.js';
import { settingsSubNav } from '../../lib/settings-subnav.js';
import { listScript, listTableHead, listToolbar, rowDataAttrs } from '../../lib/list-table.js';

const PAGE_SIZE = 200;

function fmtRelative(iso) {
  if (!iso) return '';
  const t = new Date(iso + (iso.endsWith('Z') ? '' : 'Z')).getTime();
  if (!Number.isFinite(t)) return iso;
  const d = Math.round((Date.now() - t) / 1000);
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  if (d < 604800) return Math.floor(d / 86400) + 'd ago';
  return new Date(t).toLocaleDateString();
}

function fmtDate(iso) {
  if (!iso) return '';
  const t = new Date(iso + (iso.endsWith('Z') ? '' : 'Z')).getTime();
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString();
}

function eventBadge(eventType) {
  const colors = {
    session_started: '#2563eb',
    viewed: '#6b7280',
    searched: '#8b5cf6',
    created: '#16a34a',
    updated: '#ca8a04',
    deleted: '#dc2626',
    downloaded: '#0891b2',
    stage_changed: '#ea580c',
  };
  const color = colors[eventType] || '#6b7280';
  return `<span style="display:inline-block;padding:1px 8px;border-radius:9999px;font-size:0.75rem;color:#fff;background:${color}">${escape(eventType)}</span>`;
}

function entityLink(entityType, entityId) {
  const routes = {
    opportunity: `/opportunities/${entityId}`,
    account: `/accounts/${entityId}`,
    contact: `/contacts/${entityId}`,
    document: `/documents/${entityId}/download`,
  };
  const href = routes[entityType];
  if (!href) return `${escape(entityType)} ${escape(entityId?.slice(0, 8) || '')}`;
  return `<a href="${escape(href)}">${escape(entityType)} ${escape(entityId?.slice(0, 8) || '')}</a>`;
}

function parseChanges(e) {
  if (!e.changes_json) return null;
  try { return JSON.parse(e.changes_json); } catch (_) { return null; }
}

function pageUrl(e) {
  const changes = parseChanges(e);
  return changes?.url || changes?.path || '';
}

function urlCell(e) {
  const u = pageUrl(e);
  if (!u) return '<span class="muted">—</span>';
  return `<a href="${escape(u)}" style="font-size:0.8rem;word-break:break-all">${escape(u)}</a>`;
}

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);

  if (!hasRole(user, 'admin')) {
    return htmlResponse(
      layout('Activity', `
        <section class="card">
          <h1>Activity</h1>
          <p>Admin role required to view this page.</p>
        </section>`,
        { user, env: data?.env, activeNav: '/settings' }),
      { status: 403 }
    );
  }

  const tab = url.searchParams.get('tab') || 'timeline';

  const isAdmin = true;
  const isWes = user?.email === 'wes.yoakum@c-lars.com';

  let body = '';
  try {
    if (tab === 'timeline') {
      body = await renderTimeline(env.DB);
    } else if (tab === 'by-user') {
      body = await renderByUser(env.DB);
    } else if (tab === 'adoption') {
      body = await renderAdoption(env.DB);
    }
  } catch (err) {
    body = `<div class="alert alert-danger"><strong>Query error:</strong> ${escape(String(err?.message || err))}</div>`;
  }

  // Tab nav
  const tabs = [
    { key: 'timeline', label: 'Timeline' },
    { key: 'by-user', label: 'By User' },
    { key: 'adoption', label: 'Adoption' },
  ];
  const tabLinks = tabs.map(t => `
    <a href="/settings/activity?tab=${t.key}"
       style="padding:0.5rem 1rem;text-decoration:none;font-weight:${t.key === tab ? '600' : '400'};
              color:${t.key === tab ? 'var(--primary)' : 'var(--text-muted)'};
              border-bottom:${t.key === tab ? '2px solid var(--primary)' : '2px solid transparent'};
              margin-bottom:-2px">${t.label}</a>
  `).join('');
  const tabNav = html`
    <div style="display:flex;gap:0;border-bottom:2px solid var(--border);margin-bottom:1rem">
      ${raw(tabLinks)}
    </div>
  `;

  const page = html`
    ${settingsSubNav('activity', isAdmin, isWes)}
    <section class="card">
      <div class="card-header">
        <h1>Activity</h1>
      </div>
      ${raw(tabNav)}
      ${raw(body)}
    </section>
  `;

  return htmlResponse(
    layout('Activity', page, { user, env: data?.env, activeNav: '/settings' })
  );
}

// ─── Timeline tab ──────────────────────────────────────────────────

const TIMELINE_COLUMNS = [
  { key: 'when',        label: 'When',        sort: 'text',   filter: 'text',   default: true  },
  { key: 'timestamp',   label: 'Timestamp',   sort: 'text',   filter: 'text',   default: true  },
  { key: 'user',        label: 'User',        sort: 'text',   filter: 'select', default: true  },
  { key: 'title',       label: 'Title',       sort: 'text',   filter: 'text',   default: true  },
  { key: 'url',         label: 'URL',         sort: 'text',   filter: 'text',   default: true  },
  { key: 'event_type',  label: 'Event',       sort: 'text',   filter: 'select', default: true  },
  { key: 'entity_type', label: 'Entity',      sort: 'text',   filter: 'select', default: true  },
];

async function renderTimeline(db) {
  const events = await all(db,
    `SELECT ae.id, ae.entity_type, ae.entity_id, ae.event_type, ae.at,
            ae.summary, ae.changes_json, ae.user_id,
            u.display_name AS user_name, u.email AS user_email
       FROM audit_events ae
       LEFT JOIN users u ON u.id = ae.user_id
       ORDER BY ae.at DESC
       LIMIT ?`,
    [PAGE_SIZE]
  );

  const newestAt = events.length ? events[0].at : '';

  const rowData = events.map(e => ({
    id:          e.id,
    when:        fmtRelative(e.at),
    when_iso:    e.at,
    timestamp:   fmtDate(e.at),
    user:        e.user_name || e.user_email || '—',
    title:       e.summary || '',
    url:         pageUrl(e),
    event_type:  e.event_type,
    entity_type: e.entity_type,
    // Extra fields for rendering (not columns)
    _entity_id:     e.entity_id,
    _changes_json:  e.changes_json || '',
  }));

  if (events.length === 0) {
    return html`
      <div class="card-header">
        ${listToolbar({ id: 'activity', count: 0, columns: TIMELINE_COLUMNS, compact: true })}
      </div>
      <p class="muted">No events found.</p>
      ${raw(liveScript(newestAt))}
    `;
  }

  return html`
    <div class="card-header">
      ${listToolbar({ id: 'activity', count: events.length, columns: TIMELINE_COLUMNS, compact: true })}
    </div>
    <div class="opp-list" data-columns="${escape(JSON.stringify(TIMELINE_COLUMNS))}">
      <table class="data opp-list-table">
        ${listTableHead(TIMELINE_COLUMNS)}
        <tbody data-role="rows" id="activity-tbody">
          ${rowData.map(r => html`
            <tr data-row-id="${escape(r.id)}" ${raw(rowDataAttrs(TIMELINE_COLUMNS, r))}>
              <td class="col-when" data-col="when">
                <span title="${escape(r.when_iso)}">${escape(r.when)}</span>
              </td>
              <td class="col-timestamp" data-col="timestamp" style="white-space:nowrap;font-size:0.8rem;color:var(--text-muted)">
                ${escape(r.timestamp)}
              </td>
              <td class="col-user" data-col="user">${escape(r.user)}</td>
              <td class="col-title" data-col="title">${escape(r.title)}</td>
              <td class="col-url" data-col="url">${raw(urlCell({ changes_json: r._changes_json }))}</td>
              <td class="col-event_type" data-col="event_type">${raw(eventBadge(r.event_type))}</td>
              <td class="col-entity_type" data-col="entity_type">${raw(entityLink(r.entity_type, r._entity_id))}</td>
            </tr>
          `)}
        </tbody>
        <tfoot>
          <tr><th colspan="${TIMELINE_COLUMNS.length}">${events.length} event${events.length === 1 ? '' : 's'} (most recent ${PAGE_SIZE})</th></tr>
        </tfoot>
      </table>
    </div>
    <script>${raw(listScript('pipeline.activity.v1', 'when', 'desc'))}</script>
    ${raw(liveScript(newestAt))}
  `;
}

function liveScript(newestAt) {
  return `
    <script>
    (function() {
      var cursor = ${JSON.stringify(newestAt || new Date().toISOString())};
      var tbody = document.getElementById('activity-tbody');
      if (!tbody) return;

      var BADGE_COLORS = {
        session_started: '#2563eb', viewed: '#6b7280', searched: '#8b5cf6',
        created: '#16a34a', updated: '#ca8a04', deleted: '#dc2626',
        downloaded: '#0891b2', stage_changed: '#ea580c'
      };

      function esc(s) {
        if (!s) return '';
        var d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
      }

      function relTime(iso) {
        if (!iso) return '';
        var t = new Date(iso.endsWith('Z') ? iso : iso + 'Z').getTime();
        var d = Math.round((Date.now() - t) / 1000);
        if (d < 60) return 'just now';
        if (d < 3600) return Math.floor(d / 60) + 'm ago';
        if (d < 86400) return Math.floor(d / 3600) + 'h ago';
        return Math.floor(d / 86400) + 'd ago';
      }

      function fmtTs(iso) {
        if (!iso) return '';
        var t = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
        return t.toLocaleString();
      }

      function getUrl(e) {
        var changes = null;
        try { if (e.changes_json) changes = JSON.parse(e.changes_json); } catch(_) {}
        return (changes && (changes.url || changes.path)) || '';
      }

      function urlCellHtml(e) {
        var u = getUrl(e);
        if (!u) return '<span class="muted">\\u2014</span>';
        return '<a href="' + esc(u) + '" style="font-size:0.8rem;word-break:break-all">' + esc(u) + '</a>';
      }

      function badge(type) {
        var c = BADGE_COLORS[type] || '#6b7280';
        return '<span style="display:inline-block;padding:1px 8px;border-radius:9999px;font-size:0.75rem;color:#fff;background:' + c + '">' + esc(type) + '</span>';
      }

      function entityCell(type, id) {
        var routes = { opportunity:'/opportunities/', account:'/accounts/', contact:'/contacts/', document:'/documents/' };
        var short = (id || '').slice(0, 8);
        if (routes[type]) return '<a href="' + routes[type] + esc(id) + '">' + esc(type) + ' ' + esc(short) + '</a>';
        return esc(type) + ' ' + esc(short);
      }

      function buildRow(e) {
        var when = relTime(e.at);
        var ts = fmtTs(e.at);
        var user = e.user_name || e.user_email || '\\u2014';
        var title = e.summary || '';
        var url = getUrl(e);
        var attrs = ' data-row-id="' + esc(e.id) + '"'
          + ' data-when="' + esc(when) + '"'
          + ' data-timestamp="' + esc(ts) + '"'
          + ' data-user="' + esc(user) + '"'
          + ' data-title="' + esc(title) + '"'
          + ' data-url="' + esc(url) + '"'
          + ' data-event_type="' + esc(e.event_type) + '"'
          + ' data-entity_type="' + esc(e.entity_type) + '"';
        return '<tr style="animation:fadeIn .3s"' + attrs + '>'
          + '<td class="col-when" data-col="when"><span title="' + esc(e.at) + '">' + when + '</span></td>'
          + '<td class="col-timestamp" data-col="timestamp" style="white-space:nowrap;font-size:0.8rem;color:var(--text-muted)">' + ts + '</td>'
          + '<td class="col-user" data-col="user">' + esc(user) + '</td>'
          + '<td class="col-title" data-col="title">' + esc(title) + '</td>'
          + '<td class="col-url" data-col="url">' + urlCellHtml(e) + '</td>'
          + '<td class="col-event_type" data-col="event_type">' + badge(e.event_type) + '</td>'
          + '<td class="col-entity_type" data-col="entity_type">' + entityCell(e.entity_type, e.entity_id) + '</td>'
          + '</tr>';
      }

      function poll() {
        fetch('/settings/activity/poll?after=' + encodeURIComponent(cursor))
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (!data.ok || !data.events || !data.events.length) return;
            var fragment = '';
            for (var i = data.events.length - 1; i >= 0; i--) {
              fragment = buildRow(data.events[i]) + fragment;
            }
            tbody.insertAdjacentHTML('afterbegin', fragment);
            cursor = data.events[0].at;
            // Update count badge
            var countEl = document.querySelector('[data-role="count"]');
            if (countEl) countEl.textContent = tbody.children.length;
            // Tell the list-table controller about the new rows so it
            // applies column order, visibility, sort, and filters.
            var host = tbody.closest('.opp-list');
            if (host) host.dispatchEvent(new CustomEvent('list:rows-added'));
          })
          .catch(function() {});
      }

      setInterval(poll, 10000);

      // Update relative times every 30s
      setInterval(function() {
        tbody.querySelectorAll('.col-when span[title]').forEach(function(span) {
          var iso = span.getAttribute('title');
          if (iso) span.textContent = relTime(iso);
        });
      }, 30000);
    })();
    </script>
    <style>@keyframes fadeIn { from { opacity: 0; background: var(--highlight, #fef9c3); } to { opacity: 1; background: transparent; } }</style>
  `;
}

// ─── By User tab ───────────────────────────────────────────────────

async function renderByUser(db) {
  const stats = await all(db,
    `SELECT u.id, u.email, u.display_name, u.last_seen_at,
            (SELECT COUNT(*) FROM audit_events ae
              WHERE ae.user_id = u.id AND ae.event_type = 'session_started'
                AND ae.at >= datetime('now', '-7 days')) AS sessions_7d,
            (SELECT COUNT(*) FROM audit_events ae
              WHERE ae.user_id = u.id
                AND ae.at >= datetime('now', '-7 days')) AS events_7d,
            (SELECT COUNT(*) FROM user_page_views pv
              WHERE pv.user_id = u.id
                AND pv.at >= datetime('now', '-7 days')) AS views_7d
       FROM users u
      WHERE u.active = 1
      ORDER BY u.last_seen_at IS NULL, u.last_seen_at DESC`
  );

  if (stats.length === 0) {
    return '<p class="muted">No users found.</p>';
  }

  const rows = stats.map(u => {
    const name = u.display_name || u.email || '—';
    return `
      <tr>
        <td><strong>${escape(name)}</strong><br><small class="muted">${escape(u.email || '')}</small></td>
        <td style="text-align:center">${u.sessions_7d}</td>
        <td style="text-align:center">${u.events_7d}</td>
        <td style="text-align:center">${u.views_7d}</td>
        <td style="white-space:nowrap" title="${escape(u.last_seen_at || '')}">${fmtRelative(u.last_seen_at)}</td>
      </tr>
    `;
  }).join('');

  return `
    <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:0.75rem">Last 7 days</p>
    <div style="overflow-x:auto">
      <table class="list-table" style="width:100%">
        <thead><tr>
          <th>User</th>
          <th style="text-align:center">Sessions</th>
          <th style="text-align:center">Events</th>
          <th style="text-align:center">Page Views</th>
          <th>Last Seen</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// ─── Adoption tab ──────────────────────────────────────────────────

async function renderAdoption(db) {
  const active7 = await one(db,
    `SELECT COUNT(DISTINCT user_id) AS cnt FROM user_page_views WHERE at >= datetime('now', '-7 days')`);
  const active30 = await one(db,
    `SELECT COUNT(DISTINCT user_id) AS cnt FROM user_page_views WHERE at >= datetime('now', '-30 days')`);

  const sessionsPerDay = await all(db,
    `SELECT date(at) AS day, COUNT(*) AS cnt
       FROM audit_events
      WHERE event_type = 'session_started'
        AND at >= datetime('now', '-14 days')
      GROUP BY date(at)
      ORDER BY day`
  );

  const viewsPerDay = await all(db,
    `SELECT date(at) AS day, COUNT(*) AS cnt
       FROM user_page_views
      WHERE at >= datetime('now', '-14 days')
      GROUP BY date(at)
      ORDER BY day`
  );

  const hourly = await all(db,
    `SELECT CAST(strftime('%H', at) AS INTEGER) AS hour, COUNT(*) AS cnt
       FROM user_page_views
      WHERE at >= datetime('now', '-30 days')
      GROUP BY hour
      ORDER BY hour`
  );

  const maxSessions = Math.max(1, ...sessionsPerDay.map(r => r.cnt));
  const maxViews = Math.max(1, ...viewsPerDay.map(r => r.cnt));
  const maxHour = Math.max(1, ...hourly.map(r => r.cnt));

  const sessionBars = sessionsPerDay.map(r => `
    <div style="display:flex;flex-direction:column;align-items:center;flex:1;min-width:0" title="${r.day}: ${r.cnt}">
      <div style="width:100%;max-width:28px;height:${Math.round((r.cnt / maxSessions) * 80)}px;background:var(--primary);border-radius:2px 2px 0 0;min-height:2px"></div>
      <small style="font-size:0.6rem;color:var(--text-muted);writing-mode:vertical-rl;transform:rotate(180deg);margin-top:2px">${r.day.slice(5)}</small>
    </div>
  `).join('');

  const viewBars = viewsPerDay.map(r => `
    <div style="display:flex;flex-direction:column;align-items:center;flex:1;min-width:0" title="${r.day}: ${r.cnt}">
      <div style="width:100%;max-width:28px;height:${Math.round((r.cnt / maxViews) * 80)}px;background:#8b5cf6;border-radius:2px 2px 0 0;min-height:2px"></div>
      <small style="font-size:0.6rem;color:var(--text-muted);writing-mode:vertical-rl;transform:rotate(180deg);margin-top:2px">${r.day.slice(5)}</small>
    </div>
  `).join('');

  const hourBars = Array.from({ length: 24 }, (_, h) => {
    const row = hourly.find(r => r.hour === h);
    const cnt = row?.cnt || 0;
    const opacity = cnt ? Math.max(0.15, cnt / maxHour) : 0.05;
    return `<div title="${h}:00 — ${cnt} views" style="flex:1;height:32px;background:rgba(37,99,235,${opacity.toFixed(2)});border-right:1px solid var(--bg)"></div>`;
  }).join('');

  return `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:1rem;margin-bottom:1.5rem">
      <div class="card" style="text-align:center;padding:1rem">
        <div style="font-size:2rem;font-weight:700">${active7?.cnt ?? 0}</div>
        <div style="font-size:0.8rem;color:var(--text-muted)">Active users (7d)</div>
      </div>
      <div class="card" style="text-align:center;padding:1rem">
        <div style="font-size:2rem;font-weight:700">${active30?.cnt ?? 0}</div>
        <div style="font-size:0.8rem;color:var(--text-muted)">Active users (30d)</div>
      </div>
      <div class="card" style="text-align:center;padding:1rem">
        <div style="font-size:2rem;font-weight:700">${sessionsPerDay.reduce((s, r) => s + r.cnt, 0)}</div>
        <div style="font-size:0.8rem;color:var(--text-muted)">Sessions (14d)</div>
      </div>
      <div class="card" style="text-align:center;padding:1rem">
        <div style="font-size:2rem;font-weight:700">${viewsPerDay.reduce((s, r) => s + r.cnt, 0)}</div>
        <div style="font-size:0.8rem;color:var(--text-muted)">Page views (14d)</div>
      </div>
    </div>

    <h3 style="margin:1rem 0 0.5rem">Sessions per day</h3>
    <div style="display:flex;align-items:end;gap:2px;height:120px;padding:0 0.5rem">
      ${sessionBars || '<p class="muted">No session data yet.</p>'}
    </div>

    <h3 style="margin:1.5rem 0 0.5rem">Page views per day</h3>
    <div style="display:flex;align-items:end;gap:2px;height:120px;padding:0 0.5rem">
      ${viewBars || '<p class="muted">No page view data yet.</p>'}
    </div>

    <h3 style="margin:1.5rem 0 0.5rem">Activity by hour (last 30 days)</h3>
    <div style="display:flex;align-items:stretch;gap:0;border-radius:4px;overflow:hidden">
      ${hourBars}
    </div>
    <div style="display:flex;justify-content:space-between;font-size:0.65rem;color:var(--text-muted);padding:2px 0">
      <span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>12am</span>
    </div>
  `;
}
