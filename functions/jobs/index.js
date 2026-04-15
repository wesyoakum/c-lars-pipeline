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
import { listScript, listTableHead, listToolbar, rowDataAttrs } from '../lib/list-table.js';
import { ieText, listInlineEditScript } from '../lib/list-inline-edit.js';

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
    { key: 'open',         label: '\u2197',   sort: 'text',   filter: null,     default: true },
    { key: 'number',       label: 'Job #',    sort: 'text',   filter: 'text',   default: true },
    { key: 'title',        label: 'Title',    sort: 'text',   filter: 'text',   default: true },
    { key: 'account_name', label: 'Account',  sort: 'text',   filter: 'text',   default: true },
    { key: 'opp_number',   label: 'Opp #',    sort: 'text',   filter: 'text',   default: true },
    { key: 'type_label',   label: 'Type',     sort: 'text',   filter: 'select', default: true },
    { key: 'status_label', label: 'Status',   sort: 'text',   filter: 'select', default: true },
    { key: 'oc_number',    label: 'OC #',     sort: 'text',   filter: 'text',   default: true },
    { key: 'updated',      label: 'Updated',  sort: 'date',   filter: 'text',   default: true },
    { key: 'created',      label: 'Created',  sort: 'date',   filter: 'text',   default: false },
  ];

  const rowData = rows.map(r => ({
    id: r.id,
    number: r.number ?? '',
    title: r.title ?? '',
    account_name: r.account_name ?? '',
    opp_number: r.opp_number ?? '',
    opp_id: r.opp_id ?? '',
    type_label: parseTransactionTypes(r.job_type).map(t => TYPE_LABELS[t] ?? t).join(', ') || r.job_type || '\u2014',
    status_label: STATUS_LABELS[r.status] ?? r.status ?? '',
    status: r.status,
    oc_number: r.oc_number ?? '',
    updated: (r.updated_at ?? '').slice(0, 10),
    created: (r.created_at ?? '').slice(0, 10),
  }));

  const body = html`
    <section class="card">
      <div class="card-header">
        <h1 class="page-title">Jobs</h1>
        ${listToolbar({ id: 'jobs', count: rows.length, columns })}
      </div>

      ${rows.length === 0
        ? html`<p class="muted">No jobs yet. Jobs are created when an opportunity reaches Closed Won.</p>`
        : html`
          <div class="opp-list" data-columns="${escape(JSON.stringify(columns))}">
            <table class="data opp-list-table">
              ${listTableHead(columns, rowData)}
              <tbody data-role="rows">
                ${rowData.map(r => html`
                  <tr data-row-id="${escape(r.id)}"
                      ${raw(rowDataAttrs(columns, r))}>
                    <td class="col-open" data-col="open">
                      <a class="row-open-link" href="/jobs/${escape(r.id)}" title="Open job" aria-label="Open job">\u2197</a>
                    </td>
                    <td class="col-number" data-col="number"><a href="/jobs/${escape(r.id)}"><strong>${escape(r.number)}</strong></a></td>
                    <td class="col-title" data-col="title">
                      ${ieText('title', r.title)}
                    </td>
                    <td class="col-account_name" data-col="account_name">${r.opp_id ? html`<a href="/opportunities/${escape(r.opp_id)}">${escape(r.account_name)}</a>` : escape(r.account_name)}</td>
                    <td class="col-opp_number" data-col="opp_number">${r.opp_id ? html`<a href="/opportunities/${escape(r.opp_id)}">${escape(r.opp_number)}</a>` : escape(r.opp_number)}</td>
                    <td class="col-type_label" data-col="type_label">${escape(r.type_label)}</td>
                    <td class="col-status_label" data-col="status_label"><span class="pill ${r.status === 'handed_off' ? 'pill-success' : r.status === 'cancelled' ? 'pill-locked' : ''}">${escape(r.status_label)}</span></td>
                    <td class="col-oc_number" data-col="oc_number">${escape(r.oc_number)}</td>
                    <td class="col-updated" data-col="updated"><small class="muted">${escape(r.updated)}</small></td>
                    <td class="col-created" data-col="created"><small class="muted">${escape(r.created)}</small></td>
                  </tr>`)}
              </tbody>
            </table>
          </div>
          <script>${raw(listScript('pms.jobs.v1'))}</script>
          <script>${raw(listInlineEditScript('/jobs/:id/patch'))}</script>`}
    </section>`;

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
