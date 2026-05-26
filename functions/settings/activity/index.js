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

const PAGE_SIZE = 50;

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
    quote: `/opportunities/—/quotes/${entityId}`,
    document: `/documents/${entityId}/download`,
  };
  const href = routes[entityType];
  if (!href || href.includes('—')) return `${escape(entityType)} ${escape(entityId?.slice(0, 8) || '')}`;
  return `<a href="${escape(href)}">${escape(entityType)} ${escape(entityId?.slice(0, 8) || '')}</a>`;
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
  const filterUser = url.searchParams.get('user') || '';
  const filterEvent = url.searchParams.get('event') || '';
  const filterEntity = url.searchParams.get('entity') || '';
  const filterFrom = url.searchParams.get('from') || '';
  const filterTo = url.searchParams.get('to') || '';
  const cursor = url.searchParams.get('cursor') || '';

  const isAdmin = true;
  const isWes = user?.email === 'wes.yoakum@c-lars.com';

  let body = '';
  try {
    // Load users for filter dropdown
    const users = await all(env.DB,
      `SELECT id, email, display_name FROM users WHERE active = 1 ORDER BY display_name`);

    if (tab === 'timeline') {
      body = await renderTimeline(env.DB, { users, filterUser, filterEvent, filterEntity, filterFrom, filterTo, cursor });
    } else if (tab === 'by-user') {
      body = await renderByUser(env.DB, { users });
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
  const tabNav = html`
    <div style="display:flex;gap:0;border-bottom:2px solid var(--border);margin-bottom:1rem">
      ${tabs.map(t => `
        <a href="/settings/activity?tab=${t.key}"
           style="padding:0.5rem 1rem;text-decoration:none;font-weight:${t.key === tab ? '600' : '400'};
                  color:${t.key === tab ? 'var(--primary)' : 'var(--text-muted)'};
                  border-bottom:${t.key === tab ? '2px solid var(--primary)' : '2px solid transparent'};
                  margin-bottom:-2px">${t.label}</a>
      `).join('')}
    </div>
  `;

  const page = html`
    ${settingsSubNav('activity', isAdmin, isWes)}
    <section class="card">
      <h1>Activity</h1>
      ${raw(tabNav)}
      ${raw(body)}
    </section>
  `;

  return htmlResponse(
    layout('Activity', page, { user, env: data?.env, activeNav: '/settings' })
  );
}

// ─── Timeline tab ──────────────────────────────────────────────────

async function renderTimeline(db, { users, filterUser, filterEvent, filterEntity, filterFrom, filterTo, cursor }) {
  // Build WHERE clauses
  const where = [];
  const params = [];

  if (filterUser) {
    where.push('ae.user_id = ?');
    params.push(filterUser);
  }
  if (filterEvent) {
    where.push('ae.event_type = ?');
    params.push(filterEvent);
  }
  if (filterEntity) {
    where.push('ae.entity_type = ?');
    params.push(filterEntity);
  }
  if (filterFrom) {
    where.push("ae.at >= ?");
    params.push(filterFrom);
  }
  if (filterTo) {
    where.push("ae.at <= ?");
    params.push(filterTo + 'T23:59:59');
  }
  if (cursor) {
    where.push('ae.at < ?');
    params.push(cursor);
  }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const events = await all(db,
    `SELECT ae.id, ae.entity_type, ae.entity_id, ae.event_type, ae.at,
            ae.summary, ae.user_id,
            u.display_name AS user_name, u.email AS user_email
       FROM audit_events ae
       LEFT JOIN users u ON u.id = ae.user_id
       ${whereClause}
       ORDER BY ae.at DESC
       LIMIT ?`,
    [...params, PAGE_SIZE + 1]
  );

  const hasMore = events.length > PAGE_SIZE;
  const display = events.slice(0, PAGE_SIZE);
  const nextCursor = hasMore ? display[display.length - 1].at : '';

  // Event types for filter dropdown
  const eventTypes = await all(db,
    `SELECT DISTINCT event_type FROM audit_events ORDER BY event_type`);
  const entityTypes = await all(db,
    `SELECT DISTINCT entity_type FROM audit_events ORDER BY entity_type`);

  // Build filter form
  const filterForm = `
    <form method="get" action="/settings/activity" style="display:flex;flex-wrap:wrap;gap:0.5rem;margin-bottom:1rem;align-items:end">
      <input type="hidden" name="tab" value="timeline">
      <label style="display:flex;flex-direction:column;font-size:0.8rem;color:var(--text-muted)">
        User
        <select name="user" style="min-width:140px">
          <option value="">All users</option>
          ${users.map(u => `<option value="${escape(u.id)}" ${u.id === filterUser ? 'selected' : ''}>${escape(u.display_name || u.email)}</option>`).join('')}
        </select>
      </label>
      <label style="display:flex;flex-direction:column;font-size:0.8rem;color:var(--text-muted)">
        Event type
        <select name="event" style="min-width:140px">
          <option value="">All events</option>
          ${eventTypes.map(e => `<option value="${escape(e.event_type)}" ${e.event_type === filterEvent ? 'selected' : ''}>${escape(e.event_type)}</option>`).join('')}
        </select>
      </label>
      <label style="display:flex;flex-direction:column;font-size:0.8rem;color:var(--text-muted)">
        Entity type
        <select name="entity" style="min-width:140px">
          <option value="">All entities</option>
          ${entityTypes.map(e => `<option value="${escape(e.entity_type)}" ${e.entity_type === filterEntity ? 'selected' : ''}>${escape(e.entity_type)}</option>`).join('')}
        </select>
      </label>
      <label style="display:flex;flex-direction:column;font-size:0.8rem;color:var(--text-muted)">
        From
        <input type="date" name="from" value="${escape(filterFrom)}" style="min-width:130px">
      </label>
      <label style="display:flex;flex-direction:column;font-size:0.8rem;color:var(--text-muted)">
        To
        <input type="date" name="to" value="${escape(filterTo)}" style="min-width:130px">
      </label>
      <button type="submit" class="btn btn-sm">Filter</button>
      <a href="/settings/activity?tab=timeline" class="btn btn-sm btn-ghost">Clear</a>
    </form>
  `;

  if (display.length === 0) {
    return filterForm + '<p style="color:var(--text-muted)">No events found.</p>';
  }

  const rows = display.map(e => `
    <tr>
      <td style="white-space:nowrap;font-size:0.8rem" title="${escape(e.at)}">${fmtRelative(e.at)}</td>
      <td>${escape(e.user_name || e.user_email || '—')}</td>
      <td>${eventBadge(e.event_type)}</td>
      <td>${entityLink(e.entity_type, e.entity_id)}</td>
      <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escape(e.summary || '')}</td>
    </tr>
  `).join('');

  const nextLink = hasMore
    ? `<a href="/settings/activity?tab=timeline&cursor=${encodeURIComponent(nextCursor)}&user=${encodeURIComponent(filterUser)}&event=${encodeURIComponent(filterEvent)}&entity=${encodeURIComponent(filterEntity)}&from=${encodeURIComponent(filterFrom)}&to=${encodeURIComponent(filterTo)}" class="btn btn-sm" style="margin-top:0.5rem">Older &rarr;</a>`
    : '';

  return `
    ${filterForm}
    <div style="overflow-x:auto">
      <table class="list-table" style="width:100%">
        <thead><tr>
          <th>When</th><th>User</th><th>Event</th><th>Entity</th><th>Summary</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${nextLink}
  `;
}

// ─── By User tab ───────────────────────────────────────────────────

async function renderByUser(db, { users }) {
  // Per-user stats: sessions this week, last seen, top entity types touched
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
    return '<p style="color:var(--text-muted)">No users found.</p>';
  }

  const rows = stats.map(u => {
    const name = u.display_name || u.email || '—';
    return `
      <tr>
        <td><strong>${escape(name)}</strong><br><small style="color:var(--text-muted)">${escape(u.email || '')}</small></td>
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
  // Active users (7d and 30d)
  const active7 = await one(db,
    `SELECT COUNT(DISTINCT user_id) AS cnt FROM user_page_views WHERE at >= datetime('now', '-7 days')`);
  const active30 = await one(db,
    `SELECT COUNT(DISTINCT user_id) AS cnt FROM user_page_views WHERE at >= datetime('now', '-30 days')`);

  // Sessions per day (last 14 days)
  const sessionsPerDay = await all(db,
    `SELECT date(at) AS day, COUNT(*) AS cnt
       FROM audit_events
      WHERE event_type = 'session_started'
        AND at >= datetime('now', '-14 days')
      GROUP BY date(at)
      ORDER BY day`
  );

  // Page views per day (last 14 days)
  const viewsPerDay = await all(db,
    `SELECT date(at) AS day, COUNT(*) AS cnt
       FROM user_page_views
      WHERE at >= datetime('now', '-14 days')
      GROUP BY date(at)
      ORDER BY day`
  );

  // Hour-of-day heatmap (last 30 days)
  const hourly = await all(db,
    `SELECT CAST(strftime('%H', at) AS INTEGER) AS hour, COUNT(*) AS cnt
       FROM user_page_views
      WHERE at >= datetime('now', '-30 days')
      GROUP BY hour
      ORDER BY hour`
  );

  // Build sparkline-style bar charts using plain HTML
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

  // Hour heatmap as horizontal bar
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
      ${sessionBars || '<p style="color:var(--text-muted)">No session data yet.</p>'}
    </div>

    <h3 style="margin:1.5rem 0 0.5rem">Page views per day</h3>
    <div style="display:flex;align-items:end;gap:2px;height:120px;padding:0 0.5rem">
      ${viewBars || '<p style="color:var(--text-muted)">No page view data yet.</p>'}
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
