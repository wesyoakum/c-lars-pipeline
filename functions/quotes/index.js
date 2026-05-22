// functions/quotes/index.js
//
// GET /quotes — list all quotes across all opportunities.
// Full sort/filter/column-toggle table using shared list-table controller.

import { all } from '../lib/db.js';
import { layout, htmlResponse, html, raw, escape, subnavTabs } from '../lib/layout.js';
import { readFlash } from '../lib/http.js';
import { fmtDollar } from '../lib/pricing.js';
import {
  QUOTE_STATUS_LABELS,
  quoteTypeDisplayLabel,
} from '../lib/validators.js';
import { listScript, listTableHead, listToolbar, rowDataAttrs } from '../lib/list-table.js';
import { ieText, listInlineEditScript } from '../lib/list-inline-edit.js';
import { displayAccountForGroupMode } from '../lib/account-groups.js';

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const prefs = {
    show_alias: !!(user && user.show_alias),
    group_rollup: !!(user && user.group_rollup),
  };

  // Load all quotes — filtering is client-side via the Status column's
  // default filter preset so the user can toggle to see all statuses.
  const rows = await all(
    env.DB,
    `SELECT q.id, q.number, q.revision, q.quote_type, q.status,
            q.title, q.total_price, q.valid_until,
            q.created_at, q.updated_at,
            q.opportunity_id, q.external_source,
            o.number AS opp_number, o.title AS opp_title, o.stage AS opp_stage,
            a.name AS account_name, a.id AS account_id,
            a.alias AS account_alias, a.parent_group AS account_parent_group
       FROM quotes q
       LEFT JOIN opportunities o ON o.id = q.opportunity_id
       LEFT JOIN accounts a      ON a.id = o.account_id
      WHERE q.deleted_at IS NULL
      ORDER BY q.updated_at DESC`
  );

  // Stage keys in pipeline process order for the opp-stage chart.
  const stageOrderRows = await all(env.DB,
    `SELECT DISTINCT stage_key FROM stage_definitions ORDER BY sort_order`);
  const stageKeyOrder = stageOrderRows.map(r => r.stage_key);

  const STATUS_ORDER = ['Draft', 'Issued', 'Revision Draft', 'Revision Issued', 'Expired', 'Accepted', 'Rejected', 'Dead'];

  const columns = [
    { key: 'number',       label: 'Number',      sort: 'text',   filter: 'text',   default: true },
    { key: 'revision',     label: 'Rev',          sort: 'text',   filter: 'text',   default: true },
    { key: 'type_label',   label: 'Type',         sort: 'text',   filter: 'select', default: true },
    { key: 'title',        label: 'Title',        sort: 'text',   filter: 'text',   default: true },
    { key: 'opp_number',   label: 'Opportunity',  sort: 'text',   filter: 'text',   default: true },
    { key: 'account_name', label: 'Account',      sort: 'text',   filter: 'text',   default: true },
    {
      key: 'status_label', label: 'Status', sort: 'text', filter: 'select', default: true,
      // Preset subsets shown above the checkbox list in the filter
      // popover. "Active" = the statuses the user is likely still
      // acting on; "Inactive" = fully-settled / dead ones.
      optionOrder: STATUS_ORDER,
      quickFilters: [
        { label: 'Active',   values: ['Draft', 'Issued', 'Revision Draft', 'Revision Issued', 'Expired'] },
        { label: 'Inactive', values: ['Accepted', 'Rejected', 'Dead'] },
      ],
    },
    { key: 'total',        label: 'Total',        sort: 'number', filter: 'range',  default: true },
    { key: 'valid_until',  label: 'Valid until',   sort: 'date',   filter: 'text',   default: true },
    { key: 'updated',      label: 'Updated',      sort: 'date',   filter: 'text',   default: true },
    { key: 'created',      label: 'Created',      sort: 'date',   filter: 'text',   default: false },
    // WFM-imported vs Pipeline-native. Off by default; flip on via the
    // column-picker when auditing import coverage.
    { key: 'opp_stage',    label: 'Opp Stage',    sort: 'text',   filter: 'select', default: false },
    { key: 'source',       label: 'Source',       sort: 'text',   filter: 'select', default: false },
    // Delete affordance \u2014 only renders the button for draft / revision-
    // draft rows; other statuses get a hyphen. Server-side route blocks
    // the destructive action on locked statuses regardless.
    { key: 'actions',      label: '',              sort: null,     filter: null,    default: true },
  ];

  // Quote statuses we offer a delete button for. Mirrors the LOCKED_FOR_DELETE
  // set in functions/opportunities/[id]/quotes/[quoteId]/delete.js \u2014 anything
  // not in the deletable set is server-rejected anyway, but we hide the
  // button so the user doesn't get a misleading affordance.
  const DELETABLE_STATUSES = new Set(['draft', 'revision_draft']);

  const rowData = rows.map(r => {
    const acct = r.account_id
      ? displayAccountForGroupMode(
          {
            id: r.account_id,
            name: r.account_name,
            alias: r.account_alias,
            parent_group: r.account_parent_group,
          },
          prefs
        )
      : { label: '', href: '' };
    return {
      id: r.id,
      opp_id: r.opportunity_id,
      number: r.number ?? '',
      revision: r.revision ?? '',
      type_label: quoteTypeDisplayLabel(r.quote_type),
      status_label: QUOTE_STATUS_LABELS[r.status] ?? r.status ?? '',
      status: r.status,
      title: r.title ?? '',
      // Combine number + opp title into the filter data so the quicksearch
      // matches either — typing part of the title finds the row even when the
      // cell displays the number prominently. The raw number is kept in
      // `opp_number_display` for the cell render.
      opp_number: `${r.opp_number ?? ''} ${r.opp_title ?? ''}`.trim(),
      opp_number_display: r.opp_number ?? '',
      opp_title: r.opp_title ?? '',
      account_name: acct.label || '',
      account_href: acct.href || '',
      account_id: r.account_id ?? '',
      total: r.total_price != null ? Number(r.total_price) : '',
      total_display: r.total_price != null ? fmtDollar(r.total_price) : '',
      valid_until: r.valid_until ?? '',
      updated: (r.updated_at ?? '').slice(0, 10),
      created: (r.created_at ?? '').slice(0, 10),
      opp_stage: r.opp_stage || '',
      source: r.external_source ? 'wfm' : 'pipeline',
    };
  });

  function statusPillClass(s) {
    switch (s) {
      case 'draft': case 'revision_draft': return '';
      case 'issued': case 'revision_issued': return 'pill-success';
      case 'accepted': return 'pill-success';
      case 'expired': return 'pill-expired';
      case 'rejected': case 'dead': return 'pill-locked';
      default: return '';
    }
  }

  const tabs = subnavTabs(
    [
      { href: '/opportunities', label: 'Opportunities' },
      { href: '/quotes',        label: 'Quotes' },
      { href: '/jobs',          label: 'Jobs' },
    ],
    '/quotes'
  );

  // (STATUS_ORDER moved above columns definition)

  const quoteChartScript = `
(function(){
  var chart = document.querySelector('[data-role="status-chart"]');
  if (!chart) return;
  var host = document.querySelector('.opp-list');
  var statusBody = chart.querySelector('[data-role="status-chart-body"]');
  var oppBody = chart.querySelector('[data-role="opp-stage-chart-body"]');
  var STATUS_ORDER = ${raw(JSON.stringify(STATUS_ORDER))};
  var STAGE_KEY_ORDER = ${raw(JSON.stringify(stageKeyOrder))};
  var stageKeyIndex = {};
  for (var si = 0; si < STAGE_KEY_ORDER.length; si++) stageKeyIndex[STAGE_KEY_ORDER[si]] = si;
  var statusOrderIndex = {};
  for (var i = 0; i < STATUS_ORDER.length; i++) statusOrderIndex[STATUS_ORDER[i]] = i;
  function orderIndex(s){ return s in statusOrderIndex ? statusOrderIndex[s] : 9999; }
  function esc(x){ return String(x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function fmt$(n){
    n = Number(n) || 0;
    if (n >= 1e9) return '$' + (n/1e9).toFixed(n >= 1e10 ? 0 : 1).replace(/\\.0$/,'') + 'B';
    if (n >= 1e6) return '$' + (n/1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\\.0$/,'') + 'M';
    if (n >= 1e3) return '$' + (n/1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\\.0$/,'') + 'K';
    return '$' + Math.round(n);
  }

  // Count/value mode toggle
  var MODE_KEY = 'pipeline.quoteStatusChart.mode.v1';
  var mode = 'count';
  try { var saved = localStorage.getItem(MODE_KEY); if (saved === 'value' || saved === 'count') mode = saved; } catch(e) {}
  var modeBtns = chart.querySelectorAll('[data-role="status-chart-mode"] button');
  function setMode(next){
    mode = next;
    try { localStorage.setItem(MODE_KEY, mode); } catch(e) {}
    for (var i = 0; i < modeBtns.length; i++){
      modeBtns[i].classList.toggle('qsc-mode-active', modeBtns[i].getAttribute('data-mode') === mode);
    }
    render();
  }
  for (var i = 0; i < modeBtns.length; i++){
    (function(btn){
      btn.classList.toggle('qsc-mode-active', btn.getAttribute('data-mode') === mode);
      btn.addEventListener('click', function(){ setMode(btn.getAttribute('data-mode')); });
    })(modeBtns[i]);
  }

  // View toggle: status vs opp_stage
  var VIEW_KEY = 'pipeline.quoteChart.view.v1';
  var view = 'status';
  try { var sv = localStorage.getItem(VIEW_KEY); if (sv === 'opp_stage') view = sv; } catch(e) {}
  var viewBtns = chart.querySelectorAll('[data-role="chart-view-toggle"] button');
  function setView(next){
    view = next;
    try { localStorage.setItem(VIEW_KEY, view); } catch(e) {}
    for (var i = 0; i < viewBtns.length; i++){
      viewBtns[i].classList.toggle('qsc-mode-active', viewBtns[i].getAttribute('data-view') === view);
    }
    statusBody.hidden = view !== 'status';
    oppBody.hidden = view !== 'opp_stage';
    render();
  }
  for (var i = 0; i < viewBtns.length; i++){
    (function(btn){
      btn.classList.toggle('qsc-mode-active', btn.getAttribute('data-view') === view);
      btn.addEventListener('click', function(){ setView(btn.getAttribute('data-view')); });
    })(viewBtns[i]);
  }
  statusBody.hidden = view !== 'status';
  oppBody.hidden = view !== 'opp_stage';

  function render(){
    if (!host){ chart.hidden = true; return; }
    var trs = host.querySelectorAll('tbody[data-role="rows"] tr[data-row-id]');
    var palette = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#06b6d4','#84cc16','#f97316','#6366f1','#14b8a6','#e11d48'];

    // Status chart
    var sCounts = {}, sValues = {}, sOrder = [], sTotal = 0;
    // Opp stage chart
    var oCounts = {}, oOrder = [], oTotal = 0;
    for (var i=0;i<trs.length;i++){
      var tr = trs[i];
      if (tr.style.display === 'none') continue;
      var ss = (tr.getAttribute('data-status_label') || '').trim() || '—';
      var sv = parseFloat(tr.getAttribute('data-total'));
      if (!isFinite(sv)) sv = 0;
      if (!(ss in sCounts)){ sCounts[ss] = 0; sValues[ss] = 0; sOrder.push(ss); }
      sCounts[ss]++; sValues[ss] += sv; sTotal++;
      var os = (tr.getAttribute('data-opp_stage') || '').trim() || '—';
      if (!(os in oCounts)){ oCounts[os] = 0; oOrder.push(os); }
      oCounts[os]++; oTotal++;
    }
    if (sTotal === 0){ chart.hidden = true; statusBody.innerHTML = ''; oppBody.innerHTML = ''; return; }
    chart.hidden = false;

    // Render status bars
    var sMetric = mode === 'value' ? sValues : sCounts;
    var sMax = 0; for (var k in sMetric){ if (sMetric[k] > sMax) sMax = sMetric[k]; }
    var sAxis = mode === 'value'
      ? (sMax <= 0 ? 1 : (function(){ var e=Math.floor(Math.log10(sMax)),st=Math.pow(10,e),a=Math.ceil(sMax/st)*st; return a===sMax?a+st:a; })())
      : Math.max(50, Math.ceil(sMax / 50) * 50);
    sOrder.sort(function(a,b){ var d=orderIndex(a)-orderIndex(b); return d!==0?d:a.localeCompare(b); });
    statusBody.innerHTML = sOrder.map(function(s,idx){
      var v = sMetric[s]; var pct = Math.round(v / sAxis * 100); var color = palette[idx % palette.length];
      var rl = mode === 'value' ? fmt$(v) : String(v);
      var tip = esc(s)+' — '+sCounts[s]+' quotes · '+fmt$(sValues[s]);
      return '<div class="qsc-row" title="'+tip+'"><span class="qsc-label" title="'+esc(s)+'">'+esc(s)+'</span><span class="qsc-track"><span class="qsc-bar" style="width:'+pct+'%;background:'+color+'"></span></span><span class="qsc-count">'+rl+'</span></div>';
    }).join('');

    // Render opp stage bars
    var oMax = 0; for (var k in oCounts){ if (oCounts[k] > oMax) oMax = oCounts[k]; }
    var oAxis = Math.max(10, Math.ceil(oMax / 10) * 10);
    oOrder.sort(function(a,b){ var da=(a in stageKeyIndex?stageKeyIndex[a]:9999),db=(b in stageKeyIndex?stageKeyIndex[b]:9999); return da!==db?da-db:a.localeCompare(b); });
    oppBody.innerHTML = oOrder.map(function(s,idx){
      var v = oCounts[s]; var pct = Math.round(v / oAxis * 100); var color = palette[idx % palette.length];
      return '<div class="qsc-row" title="'+esc(s)+': '+v+'"><span class="qsc-label" title="'+esc(s)+'">'+esc(s)+'</span><span class="qsc-track"><span class="qsc-bar" style="width:'+pct+'%;background:'+color+'"></span></span><span class="qsc-count">'+v+'</span></div>';
    }).join('');
  }
  render();
  if (host) host.addEventListener('list:filtered', render);
})();
`;

  const body = html`
    ${tabs}
    <style>
      .quote-status-chart{margin:.4rem 0 .6rem;padding:.5rem .7rem;background:var(--bg-alt,#f5f5f7);border-radius:var(--radius,6px)}
      .quote-status-chart[hidden]{display:none}
      .quote-status-chart h2{margin:0;font-size:.72rem;font-weight:600;color:var(--muted,#666);text-transform:uppercase;letter-spacing:.04em}
      .quote-status-chart-head{display:flex;align-items:center;gap:.5rem;margin-bottom:.35rem}
      .qsc-mode-toggle{display:inline-flex;border:1px solid var(--border,#d8d8d8);border-radius:4px;overflow:hidden;background:#fff}
      .qsc-mode-toggle button{background:transparent;border:0;padding:.1rem .55rem;cursor:pointer;font-size:.7rem;color:var(--muted,#666);line-height:1.4}
      .qsc-mode-toggle button + button{border-left:1px solid var(--border,#d8d8d8)}
      .qsc-mode-toggle button.qsc-mode-active{background:#eef2ff;color:#1d4ed8;font-weight:600}
      .qsc-row{display:grid;grid-template-columns:150px 1fr 60px;align-items:center;gap:.5rem;margin:.1rem 0;font-size:.8rem}
      .qsc-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text,#222)}
      .qsc-track{display:block;width:100%;background:#e5e7eb;border-radius:3px;height:11px;overflow:hidden}
      .qsc-bar{display:block;height:100%;background:#3b82f6;border-radius:3px;min-width:2px;transition:width .15s}
      .qsc-count{text-align:right;color:var(--muted,#666);font-variant-numeric:tabular-nums}
    </style>
    <div class="quote-status-chart" data-role="status-chart" hidden>
      <div class="quote-status-chart-head">
        <div class="qsc-mode-toggle" data-role="chart-view-toggle" role="group" aria-label="Chart view">
          <button type="button" data-view="status" class="qsc-mode-active">By status</button>
          <button type="button" data-view="opp_stage">By opp stage</button>
        </div>
        <span style="flex:1"></span>
        <div class="qsc-mode-toggle" data-role="status-chart-mode" role="group" aria-label="Chart metric">
          <button type="button" data-mode="count" title="Show quote count">Count</button>
          <button type="button" data-mode="value" title="Show total quote value">Value ($)</button>
        </div>
      </div>
      <div data-role="status-chart-body"></div>
      <div data-role="opp-stage-chart-body" hidden></div>
    </div>
    <section class="card">
      <div class="card-header">
        <h1 class="page-title">Quotes</h1>
        ${listToolbar({
          id: 'quotes',
          count: rows.length,
          columns,
          // Launches js/wizards/quote.js \u2014 picks account \u2192 opportunity
          // \u2192 quote type, then POSTs to the existing quote-create
          // endpoint scoped to the chosen opportunity.
          newOnClick: `window.Pipeline.openWizard('quote', {})`,
          newLabel: 'New quote',
        })}
      </div>

      ${rows.length === 0
        ? html`<p class="muted">No quotes yet. Create one from an opportunity.</p>`
        : html`
          <div class="opp-list" data-columns="${escape(JSON.stringify(columns))}">
            <table class="data opp-list-table">
              ${listTableHead(columns, rowData)}
              <tbody data-role="rows">
                ${rowData.map(r => html`
                  <tr data-row-id="${escape(r.id)}"
                      data-row-href="/opportunities/${escape(r.opp_id)}/quotes/${escape(r.id)}"
                      data-opp_id="${escape(r.opp_id)}"
                      class="${(r.status === 'dead' || r.status === 'rejected' || r.status === 'expired') ? 'row-muted' : ''}"
                      ${raw(rowDataAttrs(columns, r))}>
                    <td class="col-number" data-col="number"><a href="/opportunities/${escape(r.opp_id)}/quotes/${escape(r.id)}"><code>${escape(r.number)}</code></a></td>
                    <td class="col-revision" data-col="revision">${escape(r.revision)}</td>
                    <td class="col-type_label" data-col="type_label">${escape(r.type_label)}</td>
                    <td class="col-title" data-col="title">
                      ${ieText('title', r.title)}
                    </td>
                    <td class="col-opp_number" data-col="opp_number"><a href="/opportunities/${escape(r.opp_id)}"><code>${escape(r.opp_number_display)}</code> ${escape(r.opp_title)}</a></td>
                    <td class="col-account_name" data-col="account_name">
                      ${r.account_id
                        ? html`<a href="${escape(r.account_href)}">${escape(r.account_name)}</a>`
                        : html`<span class="muted">\u2014</span>`}
                    </td>
                    <td class="col-status_label" data-col="status_label"><span class="pill ${statusPillClass(r.status)}">${escape(r.status_label)}</span></td>
                    <td class="col-total num" data-col="total">${escape(r.total_display)}</td>
                    <td class="col-valid_until" data-col="valid_until">
                      ${ieText('valid_until', r.valid_until, { inputType: 'date' })}
                    </td>
                    <td class="col-updated" data-col="updated"><small class="muted">${escape(r.updated)}</small></td>
                    <td class="col-created" data-col="created"><small class="muted">${escape(r.created)}</small></td>
                    <td class="col-opp_stage" data-col="opp_stage">${escape(r.opp_stage)}</td>
                    <td class="col-source" data-col="source">
                      <span class="cell-text muted" style="font-size:.78rem">${escape(r.source)}</span>
                    </td>
                    <td class="col-actions" data-col="actions" style="text-align:right;white-space:nowrap">
                      ${DELETABLE_STATUSES.has(r.status) ? html`
                        <form method="post"
                              action="/opportunities/${escape(r.opp_id)}/quotes/${escape(r.id)}/delete"
                              style="display:inline;margin:0"
                              onsubmit="return confirm('Delete quote ${escape(r.number)} Rev ${escape(r.revision || 'v1')}? This removes the draft and all its lines. This cannot be undone.');">
                          <button type="submit"
                                  class="btn-ghost-x"
                                  title="Delete this draft quote"
                                  aria-label="Delete quote ${escape(r.number)}">&times;</button>
                        </form>
                      ` : html`<span class="muted" title="Only Draft / Revision Draft quotes can be deleted from this list">—</span>`}
                    </td>
                  </tr>
                `)}
              </tbody>
            </table>
          </div>
          <script>${raw(listScript('pipeline.quotes.v1', 'updated', 'desc', {
            // Default view: just the "live" statuses — Draft, Issued,
            // Expired. Hides Accepted/Rejected/Dead so the main list is
            // the set of quotes that still need attention. Users can
            // clear the Status column filter to widen.
            status_label: { values: ['Draft', 'Issued', 'Expired'] },
          }))}</script>
          <script>${raw(listInlineEditScript('/opportunities/:opp_id/quotes/:id/patch'))}</script>
          <script>${raw(quoteChartScript)}</script>
        `}
    </section>
  `;

  return htmlResponse(
    layout('Quotes', body, {
      user,
      env: data?.env,
      activeNav: '/opportunities',
      flash: readFlash(url),
      breadcrumbs: [
        { label: 'Quotes' },
      ],
    })
  );
}
