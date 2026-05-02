// functions/settings/claudia/audit.js
//
// GET /settings/claudia/audit — Wes-only dashboard surfacing every
// Claudia-driven write. The data source is claudia_writes; each row
// captures action, ref_table+ref_id, before/after snapshots, batch_id,
// summary, and undone_at if it's been reversed.
//
// Each row gets a human-readable label by joining on the target table
// (accounts.name, contacts.first_name+last_name, opportunities.number,
// etc.) so the dashboard doesn't read like a stack trace. Per-row
// "undo" button posts to /settings/claudia/audit/[id]/undo and HTMX
// outerHTML-swaps the row.
//
// Filters via query string:
//   ?action=<action>     exact-match action
//   ?table=<ref_table>   exact-match ref_table
//   ?status=active|undone|all   default: all
//   ?days=<n>            how many days back (default 7, hard cap 90)
//   ?batch=<batch_id>    show only writes from this batch
//
// Hard limit 200 rows per page; deeper history lives in audit_events
// (the standard Pipeline trail).

import { all } from '../../lib/db.js';
import { layout, htmlResponse, html, escape } from '../../lib/layout.js';
import { hasRole } from '../../lib/auth.js';
import { settingsSubNav } from '../../lib/settings-subnav.js';
import { renderClaudiaAuditRow, claudiaAuditTabs, ACTION_LABEL_MAP } from '../../lib/claudia-audit-render.js';

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';
const PAGE_LIMIT = 200;
const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user || user.email !== SANDBOX_OWNER) {
    return new Response('Not found', { status: 404 });
  }

  const isAdmin = hasRole(user, 'admin');
  const url = new URL(request.url);
  const fAction = url.searchParams.get('action') || '';
  const fTable  = url.searchParams.get('table')  || '';
  const fStatus = url.searchParams.get('status') || 'all'; // active | undone | all
  const fBatch  = url.searchParams.get('batch')  || '';
  const fDays   = Math.min(Math.max(Number(url.searchParams.get('days') || DEFAULT_DAYS), 1), MAX_DAYS);

  const sinceIso = new Date(Date.now() - fDays * 86_400_000).toISOString();

  const conditions = ['user_id = ?', 'created_at > ?'];
  const params = [user.id, sinceIso];
  if (fAction) { conditions.push('action = ?'); params.push(fAction); }
  if (fTable)  { conditions.push('ref_table = ?'); params.push(fTable); }
  if (fBatch)  { conditions.push('batch_id = ?'); params.push(fBatch); }
  if (fStatus === 'active') conditions.push('undone_at IS NULL');
  if (fStatus === 'undone') conditions.push('undone_at IS NOT NULL');

  const writes = await all(
    env.DB,
    `SELECT id, action, ref_table, ref_id, batch_id, summary,
            created_at, undone_at, undo_reason
       FROM claudia_writes
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT ${PAGE_LIMIT}`,
    params
  );

  // Batch-load labels per ref_table so we don't N+1. Each table has a
  // bespoke "what's the human-readable name?" expression — joined on id.
  const labelsByRef = await loadLabels(env, writes);

  // Aggregate filter chips: every action / table that appears in the
  // visible window, so Wes can click to filter without typing.
  const actionFacets = aggregateFacet(writes, 'action');
  const tableFacets  = aggregateFacet(writes, 'ref_table');
  const totalRows    = writes.length;
  const undoneRows   = writes.filter((r) => r.undone_at).length;
  const activeRows   = totalRows - undoneRows;

  const body = html`
    ${settingsSubNav('claudia', isAdmin, true)}
    ${claudiaAuditTabs('audit')}

    <section class="card">
      <div class="card-header">
        <h1>Claudia &mdash; audit log</h1>
      </div>
      <p class="muted">
        Every Claudia-driven write across the last ${fDays} day${fDays === 1 ? '' : 's'}.
        ${totalRows} row${totalRows === 1 ? '' : 's'}; ${activeRows} active, ${undoneRows} undone.
        Writes inside the 24-hour undo window can be reversed inline; older or
        already-undone rows show as read-only.
      </p>

      <form method="get" class="claudia-audit-filters">
        ${renderFilterGroup('Action', 'action', fAction, actionFacets, ACTION_LABEL_MAP)}
        ${renderFilterGroup('Table',  'table',  fTable,  tableFacets,  null)}
        <label class="claudia-audit-filter">
          <span>Status</span>
          <select name="status">
            <option value="all"    ${fStatus === 'all'    ? 'selected' : ''}>All</option>
            <option value="active" ${fStatus === 'active' ? 'selected' : ''}>Active</option>
            <option value="undone" ${fStatus === 'undone' ? 'selected' : ''}>Undone</option>
          </select>
        </label>
        <label class="claudia-audit-filter">
          <span>Days back</span>
          <select name="days">
            ${[1, 3, 7, 14, 30, 90].map((d) => html`
              <option value="${d}" ${fDays === d ? 'selected' : ''}>${d}</option>
            `)}
          </select>
        </label>
        ${fBatch ? html`
          <label class="claudia-audit-filter">
            <span>Batch</span>
            <code style="background:rgba(0,0,0,0.04);padding:4px 8px;border-radius:4px;font-size:11px">${escape(fBatch)}</code>
            <a href="/settings/claudia/audit" class="muted" style="margin-left:6px;font-size:11px">clear</a>
          </label>
          <input type="hidden" name="batch" value="${escape(fBatch)}">
        ` : ''}
        <button type="submit" class="btn">Apply</button>
        ${(fAction || fTable || fStatus !== 'all' || fBatch || fDays !== DEFAULT_DAYS) ? html`
          <a class="btn" href="/settings/claudia/audit" style="background:transparent;border:1px solid #d0d0d5;color:#475569">Reset</a>
        ` : ''}
      </form>

      ${writes.length === 0 ? html`
        <p class="muted" style="margin-top:1rem;font-style:italic">
          No Claudia writes in this window. Either she hasn&rsquo;t done anything yet,
          or your filters narrowed everything out.
        </p>
      ` : html`
        <table class="claudia-audit-table" style="margin-top:1rem">
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>Subject</th>
              <th>Summary</th>
              <th class="claudia-audit-undo-col">Status / Undo</th>
            </tr>
          </thead>
          <tbody>
            ${writes.map((w) => renderClaudiaAuditRow(w, labelsByRef[`${w.ref_table}:${w.ref_id}`]))}
          </tbody>
        </table>
      `}
    </section>

    <style>
      .claudia-audit-filters {
        display: flex; flex-wrap: wrap; gap: 0.6rem 0.75rem;
        align-items: end;
        padding: 0.6rem 0;
        border-bottom: 1px solid #e2e8f0;
      }
      .claudia-audit-filter { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .claudia-audit-filter > span {
        font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em;
        color: #64748b; font-weight: 600;
      }
      .claudia-audit-filter select {
        font: inherit; font-size: 13px;
        padding: 5px 8px; border: 1px solid #d0d0d5; border-radius: 4px;
        background: #fff;
      }
      .claudia-audit-table {
        width: 100%; border-collapse: collapse; margin-top: 1rem;
        font-size: 13px;
      }
      .claudia-audit-table th {
        text-align: left; padding: 8px 10px;
        background: #f8fafc; border-bottom: 1px solid #e2e8f0;
        font-weight: 600; color: #475569; font-size: 11px;
        text-transform: uppercase; letter-spacing: 0.05em;
      }
      .claudia-audit-table td {
        padding: 10px; border-bottom: 1px solid #f1f5f9;
        vertical-align: top;
      }
      .claudia-audit-table .claudia-audit-undo-col {
        text-align: right; white-space: nowrap;
      }
      .claudia-audit-when {
        color: #475569; font-size: 12px; white-space: nowrap;
      }
      .claudia-audit-action {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11px; padding: 2px 8px;
        border-radius: 999px; background: #e0e7ff; color: #3730a3;
      }
      .claudia-audit-action--undo { background: #fee2e2; color: #991b1b; }
      .claudia-audit-action--update { background: #fef3c7; color: #92400e; }
      .claudia-audit-action--create { background: #dcfce7; color: #166534; }
      .claudia-audit-action--stage  { background: #dbeafe; color: #1e40af; }
      .claudia-audit-action--merge  { background: #fce7f3; color: #9d174d; }
      .claudia-audit-subject { display: flex; flex-direction: column; gap: 2px; }
      .claudia-audit-subject-link { color: #1d4ed8; text-decoration: none; font-weight: 500; }
      .claudia-audit-subject-link:hover { text-decoration: underline; }
      .claudia-audit-subject-id {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 10px; color: #94a3b8;
      }
      .claudia-audit-summary {
        color: #1e293b; line-height: 1.5;
      }
      .claudia-audit-batch {
        display: inline-block; margin-top: 4px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 10px; color: #64748b;
        background: rgba(0,0,0,0.04); padding: 2px 6px; border-radius: 4px;
        text-decoration: none;
      }
      .claudia-audit-batch:hover { background: rgba(0,0,0,0.08); }
      .claudia-audit-undo-btn {
        background: #fff; border: 1px solid #cbd5e1; color: #475569;
        padding: 4px 10px; border-radius: 4px; font-size: 12px; cursor: pointer;
      }
      .claudia-audit-undo-btn:hover { background: #fef2f2; color: #991b1b; border-color: #fecaca; }
      .claudia-audit-status {
        font-size: 11px; color: #64748b; font-style: italic;
      }
      .claudia-audit-status--undone { color: #991b1b; font-style: normal; font-weight: 500; }
      .claudia-audit-status--expired { color: #94a3b8; }
      .claudia-audit-tabs {
        display: flex; gap: 0.4rem; padding: 0.6rem 0;
        border-bottom: 1px solid #e2e8f0; margin-bottom: 0.75rem;
      }
      .claudia-audit-tabs a {
        padding: 6px 14px; text-decoration: none; color: #475569;
        border-radius: 6px; font-size: 13px; font-weight: 500;
      }
      .claudia-audit-tabs a:hover { background: #f1f5f9; color: #1a1a22; }
      .claudia-audit-tabs a.active {
        background: #2566ff; color: #fff;
      }
      @media (max-width: 720px) {
        .claudia-audit-table thead { display: none; }
        .claudia-audit-table tr {
          display: block; margin-bottom: 0.6rem;
          border: 1px solid #e2e8f0; border-radius: 6px;
          padding: 0.6rem;
        }
        .claudia-audit-table td {
          display: block; padding: 4px 0; border: 0;
        }
        .claudia-audit-table .claudia-audit-undo-col { text-align: left; }
      }
    </style>
  `;

  return htmlResponse(
    layout('Claudia — audit', body, { env: data?.env, activeNav: '/settings', user })
  );
}

/**
 * Render one filter pill-row. Builds <option> values from the visible
 * facet aggregation so Wes only sees actions/tables that actually
 * appear in his data.
 */
function renderFilterGroup(label, name, current, facets, labelMap) {
  return html`
    <label class="claudia-audit-filter">
      <span>${label}</span>
      <select name="${name}">
        <option value="">All</option>
        ${facets.map(({ key, count }) => html`
          <option value="${escape(key)}" ${current === key ? 'selected' : ''}>
            ${escape(labelMap?.[key] || key)} (${count})
          </option>
        `)}
      </select>
    </label>
  `;
}

/**
 * Build [{ key, count }] sorted by count DESC for one column over the
 * current (filtered) result set. Cheap — runs over <= 200 rows in JS.
 */
function aggregateFacet(rows, col) {
  const counts = new Map();
  for (const r of rows) {
    const k = r[col];
    if (!k) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Look up human-readable labels for every (ref_table, ref_id) pair in
 * one batched query per table. Returns a map keyed by `${ref_table}:${ref_id}`.
 *
 * Rows that no longer exist (because the original write was a CREATE
 * that got undone, or someone deleted the row outside Claudia) won't
 * appear in the result; the renderer falls back to a short-id slice.
 */
async function loadLabels(env, writes) {
  const byTable = {};
  for (const w of writes) {
    if (!byTable[w.ref_table]) byTable[w.ref_table] = new Set();
    byTable[w.ref_table].add(w.ref_id);
  }
  const out = {};
  const queries = [];
  for (const [table, idSet] of Object.entries(byTable)) {
    const ids = Array.from(idSet);
    if (ids.length === 0) continue;
    queries.push(loadLabelsForTable(env, table, ids).then((rows) => {
      for (const row of rows) {
        out[`${table}:${row.id}`] = row.__label;
      }
    }));
  }
  await Promise.all(queries);
  return out;
}

async function loadLabelsForTable(env, table, ids) {
  const placeholders = ids.map(() => '?').join(',');
  switch (table) {
    case 'accounts': {
      const rows = await all(env.DB, `SELECT id, name FROM accounts WHERE id IN (${placeholders})`, ids);
      return rows.map((r) => ({ id: r.id, __label: r.name || `account ${r.id.slice(0, 8)}` }));
    }
    case 'contacts': {
      const rows = await all(env.DB, `SELECT id, first_name, last_name, email FROM contacts WHERE id IN (${placeholders})`, ids);
      return rows.map((r) => {
        const name = `${r.first_name || ''} ${r.last_name || ''}`.trim();
        return { id: r.id, __label: name || r.email || `contact ${r.id.slice(0, 8)}` };
      });
    }
    case 'activities': {
      const rows = await all(env.DB, `SELECT id, subject, type FROM activities WHERE id IN (${placeholders})`, ids);
      return rows.map((r) => ({ id: r.id, __label: r.subject || `${r.type || 'activity'} ${r.id.slice(0, 8)}` }));
    }
    case 'opportunities': {
      const rows = await all(env.DB, `SELECT id, number, title FROM opportunities WHERE id IN (${placeholders})`, ids);
      return rows.map((r) => ({ id: r.id, __label: `${r.number || ''} ${r.title || ''}`.trim() || `opp ${r.id.slice(0, 8)}` }));
    }
    case 'quotes': {
      const rows = await all(env.DB, `SELECT id, number, title FROM quotes WHERE id IN (${placeholders})`, ids);
      return rows.map((r) => ({ id: r.id, __label: r.number || r.title || `quote ${r.id.slice(0, 8)}` }));
    }
    case 'jobs': {
      const rows = await all(env.DB, `SELECT id, number, title FROM jobs WHERE id IN (${placeholders})`, ids);
      return rows.map((r) => ({ id: r.id, __label: r.number || r.title || `job ${r.id.slice(0, 8)}` }));
    }
    default:
      return [];
  }
}
