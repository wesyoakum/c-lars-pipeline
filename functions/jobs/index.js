// functions/jobs/index.js
//
// GET  /jobs   — list all jobs with filters
// POST /jobs   — create a new job (typically auto-created from stage transition)

import { all, one, stmt, batch } from '../lib/db.js';
import { auditStmt } from '../lib/audit.js';
import { uuid, now, nextNumber, currentYear } from '../lib/ids.js';
import { layout, htmlResponse, html, raw, escape, subnavTabs } from '../lib/layout.js';
import { redirectWithFlash, formBody, readFlash } from '../lib/http.js';
import { parseTransactionTypes } from '../lib/validators.js';
import { listScript, listTableHead, listToolbar, rowDataAttrs } from '../lib/list-table.js';
import { ieText, listInlineEditScript } from '../lib/list-inline-edit.js';
import { displayAccountName, slugifyGroup } from '../lib/account-groups.js';
import { isActiveOnly, jobActivePredicate } from '../lib/activeness.js';

/**
 * Detects a request coming from the wizard modal or any XHR-style client.
 * Same three signals used in POST /accounts, /opportunities, /contacts:
 * form source=wizard, an x-requested-with header, or a JSON-only accept.
 */
function isAjaxRequest(request, input) {
  if (input?.source === 'wizard' || input?.source === 'modal') return true;
  const xrw = request.headers.get('x-requested-with');
  if (xrw && xrw.toLowerCase() === 'xmlhttprequest') return true;
  const accept = request.headers.get('accept') || '';
  return accept.includes('application/json') && !accept.includes('text/html');
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

const TYPE_LABELS = {
  spares: 'Spares',
  eps: 'Engineered Product (EPS)',
  refurb: 'Refurbishment',
  service: 'Service',
};

const STATUS_LABELS = {
  created: 'Created',
  awaiting_ntp: 'Awaiting NTP',
  handed_off: 'Handed Off',
  cancelled: 'Cancelled',
};

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const prefs = {
    show_alias: !!(user && user.show_alias),
    group_rollup: !!(user && user.group_rollup),
  };

  // Active-only filter: hide complete + cancelled jobs. handed_off
  // stays visible (job is still tracked externally until it hits
  // complete — see activeness.js).
  const activeWhere = isActiveOnly(user) ? `WHERE ${jobActivePredicate('j')}` : '';

  const rows = await all(
    env.DB,
    `SELECT j.id, j.number, j.title, j.job_type, j.status,
            j.oc_number, j.ntp_required,
            j.handed_off_at, j.created_at, j.updated_at,
            j.external_source,
            json_extract(j.wfm_payload, '$.State') AS wfm_state,
            o.stage AS opp_stage,
            o.number AS opp_number, o.title AS opp_title, o.id AS opp_id,
            a.name AS account_name, a.alias AS account_alias,
            a.parent_group AS account_parent_group
       FROM jobs j
       LEFT JOIN opportunities o ON o.id = j.opportunity_id
       LEFT JOIN accounts a ON a.id = o.account_id
      ${activeWhere ? activeWhere + ' AND j.deleted_at IS NULL' : 'WHERE j.deleted_at IS NULL'}
      ORDER BY j.updated_at DESC`
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
    { key: 'created',      label: 'Created',  sort: 'date',   filter: 'text',   default: false },
    // WFM-imported vs Pipeline-native. Off by default; flip on via the
    // column-picker when auditing import coverage.
    { key: 'wfm_status',   label: 'WFM Status', sort: 'text', filter: 'select', default: true },
    { key: 'opp_stage',    label: 'Opp Stage', sort: 'text', filter: 'select', default: false },
    { key: 'source',       label: 'Source',   sort: 'text',   filter: 'select', default: false },
  ];

  const rowData = rows.map(r => {
    const isGrouped = !!(prefs.group_rollup && r.account_parent_group);
    const acctLabel = isGrouped
      ? r.account_parent_group
      : displayAccountName({ name: r.account_name, alias: r.account_alias }, prefs);
    const acctHref = isGrouped
      ? `/accounts/group/${slugifyGroup(r.account_parent_group)}`
      : (r.opp_id ? `/opportunities/${r.opp_id}` : '');
    return {
      id: r.id,
      number: r.number ?? '',
      title: r.title ?? '',
      account_name: acctLabel || '',
      account_href: acctHref,
      opp_number: r.opp_number ?? '',
      opp_id: r.opp_id ?? '',
      type_label: parseTransactionTypes(r.job_type).map(t => TYPE_LABELS[t] ?? t).join(', ') || r.job_type || '\u2014',
      status_label: STATUS_LABELS[r.status] ?? r.status ?? '',
      status: r.status,
      oc_number: r.oc_number ?? '',
      updated: (r.updated_at ?? '').slice(0, 10),
      created: (r.created_at ?? '').slice(0, 10),
      wfm_status: r.wfm_state || '',
      opp_stage: r.opp_stage || '',
      source: r.external_source ? 'wfm' : 'pipeline',
    };
  });

  const tabs = subnavTabs(
    [
      { href: '/opportunities', label: 'Opportunities' },
      { href: '/quotes',        label: 'Quotes' },
      { href: '/jobs',          label: 'Jobs' },
    ],
    '/jobs'
  );

  const jobChartScript = `
(function(){
  var container = document.querySelector('[data-role="job-charts"]');
  if (!container) return;
  var host = document.querySelector('.opp-list');
  var wfmBody = container.querySelector('[data-role="wfm-chart-body"]');
  var oppBody = container.querySelector('[data-role="opp-chart-body"]');
  function esc(x){ return String(x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  function renderChart(bodyEl, dataKey, label) {
    if (!host || !bodyEl) return;
    var trs = host.querySelectorAll('tbody[data-role="rows"] tr[data-row-id]');
    var counts = {}, order = [], total = 0;
    for (var i=0;i<trs.length;i++){
      var tr = trs[i];
      if (tr.style.display === 'none') continue;
      var s = (tr.getAttribute('data-' + dataKey) || '').trim() || '—';
      if (!(s in counts)){ counts[s] = 0; order.push(s); }
      counts[s]++;
      total++;
    }
    if (total === 0){ bodyEl.innerHTML = ''; return; }
    var max = 0; for (var k in counts){ if (counts[k] > max) max = counts[k]; }
    var axis = Math.max(10, Math.ceil(max / 10) * 10);
    var palette = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#06b6d4','#84cc16','#f97316','#6366f1','#14b8a6','#e11d48'];
    order.sort(function(a,b){ return (counts[b] || 0) - (counts[a] || 0); });
    bodyEl.innerHTML = order.map(function(s,idx){
      var v = counts[s];
      var pct = Math.round(v / axis * 100);
      var color = palette[idx % palette.length];
      return '<div class="jc-row" title="'+esc(s)+': '+v+'"><span class="jc-label" title="'+esc(s)+'">'+esc(s)+'</span>'+
             '<span class="jc-track"><span class="jc-bar" style="width:'+pct+'%;background:'+color+'"></span></span>'+
             '<span class="jc-count">'+v+'</span></div>';
    }).join('');
  }

  function render(){
    container.hidden = false;
    renderChart(wfmBody, 'wfm_status', 'WFM Status');
    renderChart(oppBody, 'opp_stage', 'Opp Stage');
  }
  render();
  if (host) host.addEventListener('list:filtered', render);
})();
`;

  const body = html`
    ${tabs}
    <style>
      .job-charts{margin:.4rem 0 .6rem;display:grid;grid-template-columns:1fr 1fr;gap:.75rem}
      .job-chart{padding:.5rem .7rem;background:var(--bg-alt,#f5f5f7);border-radius:var(--radius,6px)}
      .job-chart h2{margin:0 0 .35rem;font-size:.72rem;font-weight:600;color:var(--muted,#666);text-transform:uppercase;letter-spacing:.04em}
      .jc-row{display:grid;grid-template-columns:130px 1fr 40px;align-items:center;gap:.5rem;margin:.1rem 0;font-size:.8rem}
      .jc-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text,#222)}
      .jc-track{display:block;width:100%;background:#e5e7eb;border-radius:3px;height:11px;overflow:hidden}
      .jc-bar{display:block;height:100%;border-radius:3px;min-width:2px;transition:width .15s}
      .jc-count{text-align:right;color:var(--muted,#666);font-variant-numeric:tabular-nums}
    </style>
    <div class="job-charts" data-role="job-charts" hidden>
      <div class="job-chart">
        <h2>Jobs by WFM Status</h2>
        <div data-role="wfm-chart-body"></div>
      </div>
      <div class="job-chart">
        <h2>Jobs by Opp Stage</h2>
        <div data-role="opp-chart-body"></div>
      </div>
    </div>
    <section class="card">
      <div class="card-header">
        <h1 class="page-title">Jobs</h1>
        ${listToolbar({ id: 'jobs', count: rows.length, columns, newOnClick: "window.Pipeline.openWizard('job', {})", newLabel: 'New job' })}
      </div>

      ${rows.length === 0
        ? html`<p class="muted">No jobs yet. Jobs are usually auto-created when an opportunity reaches Closed Won \u2014 click the <strong>+</strong> button above to start one earlier (e.g. on NTP for an EPS build).</p>`
        : html`
          <div class="opp-list" data-columns="${escape(JSON.stringify(columns))}">
            <table class="data opp-list-table">
              ${listTableHead(columns, rowData)}
              <tbody data-role="rows">
                ${rowData.map(r => html`
                  <tr data-row-id="${escape(r.id)}"
                      data-row-href="/jobs/${escape(r.id)}"
                      ${raw(rowDataAttrs(columns, r))}>
                    <td class="col-number" data-col="number"><a href="/jobs/${escape(r.id)}"><strong>${escape(r.number)}</strong></a></td>
                    <td class="col-title" data-col="title">
                      ${ieText('title', r.title)}
                    </td>
                    <td class="col-account_name" data-col="account_name">${r.account_href ? html`<a href="${escape(r.account_href)}">${escape(r.account_name)}</a>` : escape(r.account_name)}</td>
                    <td class="col-opp_number" data-col="opp_number">${r.opp_id ? html`<a href="/opportunities/${escape(r.opp_id)}">${escape(r.opp_number)}</a>` : escape(r.opp_number)}</td>
                    <td class="col-type_label" data-col="type_label">${escape(r.type_label)}</td>
                    <td class="col-status_label" data-col="status_label"><span class="pill ${r.status === 'handed_off' ? 'pill-success' : r.status === 'cancelled' ? 'pill-locked' : ''}">${escape(r.status_label)}</span></td>
                    <td class="col-oc_number" data-col="oc_number">${escape(r.oc_number)}</td>
                    <td class="col-updated" data-col="updated"><small class="muted">${escape(r.updated)}</small></td>
                    <td class="col-created" data-col="created"><small class="muted">${escape(r.created)}</small></td>
                    <td class="col-wfm_status" data-col="wfm_status">${escape(r.wfm_status)}</td>
                    <td class="col-opp_stage" data-col="opp_stage">${escape(r.opp_stage)}</td>
                    <td class="col-source" data-col="source">
                      <span class="cell-text muted" style="font-size:.78rem">${escape(r.source)}</span>
                    </td>
                  </tr>`)}
              </tbody>
            </table>
          </div>
          <script>${raw(listScript('pipeline.jobs.v1'))}</script>
          <script>${raw(listInlineEditScript('/jobs/:id/patch'))}</script>
          <script>${raw(jobChartScript)}</script>`}
    </section>`;

  return htmlResponse(
    layout('Jobs', body, {
      user,
      env: data?.env,
      activeNav: '/opportunities',
      flash: readFlash(url),
      breadcrumbs: [{ label: 'Jobs' }],
    })
  );
}

/**
 * POST /jobs — create a job manually (typically via the wizard).
 *
 * Normal path is auto-creation when an opportunity moves to closed_won
 * (see functions/opportunities/[id]/stage.js). This endpoint exists for
 * cases where a user wants to start a job before the opportunity closes
 * (common for EPS: the customer issues NTP while the opp is still in
 * `ntp_issued` stage and work begins) or to retry an auto-create that
 * somehow didn't fire.
 *
 * Required input: opportunity_id. Everything else (job_type, title,
 * customer_po_number, ntp_required) is either inherited from the
 * opportunity or computed from it.
 *
 * Optional wizard-supplied overrides: title, customer_po_number.
 *
 * Rejects if the opportunity already has a non-cancelled job — callers
 * who want to reopen a cancelled job should do it via the job detail
 * page, not by creating a duplicate.
 *
 * AJAX response: { ok, id, number, title, redirectUrl } /
 * { ok: false, error, errors }.
 */
export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const input = await formBody(request);
  const ajax = isAjaxRequest(request, input);

  const opportunityId = (input.opportunity_id || '').trim();
  if (!opportunityId) {
    const msg = 'Please pick an opportunity.';
    if (ajax) return jsonResponse({ ok: false, error: msg, errors: { opportunity_id: msg } }, 400);
    return redirectWithFlash('/jobs', msg, 'error');
  }

  // Confirm the opportunity exists and pull everything we need to seed
  // the job from it (type, default title, default PO).
  const opp = await one(env.DB,
    `SELECT id, number, title, transaction_type, customer_po_number
       FROM opportunities
      WHERE id = ?`,
    [opportunityId]);
  if (!opp) {
    const msg = 'Opportunity not found.';
    if (ajax) return jsonResponse({ ok: false, error: msg, errors: { opportunity_id: msg } }, 404);
    return redirectWithFlash('/jobs', msg, 'error');
  }

  // Reject duplicate job creations — the auto-create path uses the same
  // check when the opp moves to closed_won, so this mirrors that rule.
  const existing = await one(env.DB,
    `SELECT id, number FROM jobs WHERE opportunity_id = ? AND status != ?`,
    [opportunityId, 'cancelled']);
  if (existing) {
    const msg = `A job (${existing.number}) already exists for this opportunity.`;
    if (ajax) return jsonResponse({ ok: false, error: msg, errors: { opportunity_id: msg } }, 409);
    return redirectWithFlash('/jobs', msg, 'error');
  }

  const id = uuid();
  const number = await nextNumber(env.DB, `JOB-${currentYear()}`);
  const ts = now();

  const title = (input.title || '').trim() || opp.title;
  const customerPo = (input.customer_po_number || '').trim() || opp.customer_po_number || null;

  const oppTypes = parseTransactionTypes(opp.transaction_type);
  const isEps = oppTypes.includes('eps');

  await batch(env.DB, [
    stmt(env.DB,
      `INSERT INTO jobs
         (id, number, opportunity_id, job_type, status, title,
          customer_po_number, ntp_required, created_at, updated_at,
          created_by_user_id)
       VALUES (?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?)`,
      [id, number, opportunityId, opp.transaction_type, title,
       customerPo, isEps ? 1 : 0, ts, ts, user?.id ?? null]),
    auditStmt(env.DB, {
      entityType: 'job',
      entityId: id,
      eventType: 'created',
      user,
      summary: `Job ${number} created manually from opportunity ${opp.number} (${opp.transaction_type})`,
    }),
  ]);

  if (ajax) {
    return jsonResponse({
      ok: true,
      id,
      number,
      title,
      redirectUrl: `/jobs/${id}`,
    });
  }

  return redirectWithFlash(`/jobs/${id}`, `Job ${number} created.`);
}
