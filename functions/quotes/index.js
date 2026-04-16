// functions/quotes/index.js
//
// GET /quotes — list all quotes across all opportunities.
// Full sort/filter/column-toggle table using shared list-table controller.

import { all } from '../lib/db.js';
import { layout, htmlResponse, html, raw, escape } from '../lib/layout.js';
import { readFlash } from '../lib/http.js';
import { fmtDollar } from '../lib/pricing.js';
import {
  QUOTE_STATUS_LABELS,
  quoteTypeDisplayLabel,
} from '../lib/validators.js';
import { listScript, listTableHead, listToolbar, rowDataAttrs } from '../lib/list-table.js';
import { ieText, listInlineEditScript } from '../lib/list-inline-edit.js';

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);

  const rows = await all(
    env.DB,
    `SELECT q.id, q.number, q.revision, q.quote_type, q.status,
            q.title, q.total_price, q.valid_until,
            q.created_at, q.updated_at,
            q.opportunity_id,
            o.number AS opp_number, o.title AS opp_title,
            a.name AS account_name, a.id AS account_id
       FROM quotes q
       LEFT JOIN opportunities o ON o.id = q.opportunity_id
       LEFT JOIN accounts a      ON a.id = o.account_id
      ORDER BY q.updated_at DESC
      LIMIT 500`
  );

  const columns = [
    { key: 'open',         label: '\u2197',      sort: 'text',   filter: null,     default: true },
    { key: 'number',       label: 'Number',      sort: 'text',   filter: 'text',   default: true },
    { key: 'revision',     label: 'Rev',          sort: 'text',   filter: 'text',   default: true },
    { key: 'type_label',   label: 'Type',         sort: 'text',   filter: 'select', default: true },
    { key: 'title',        label: 'Title',        sort: 'text',   filter: 'text',   default: true },
    { key: 'opp_number',   label: 'Opportunity',  sort: 'text',   filter: 'text',   default: true },
    { key: 'account_name', label: 'Account',      sort: 'text',   filter: 'text',   default: true },
    { key: 'status_label', label: 'Status',       sort: 'text',   filter: 'select', default: true },
    { key: 'total',        label: 'Total',        sort: 'number', filter: 'range',  default: true },
    { key: 'valid_until',  label: 'Valid until',   sort: 'date',   filter: 'text',   default: true },
    { key: 'updated',      label: 'Updated',      sort: 'date',   filter: 'text',   default: true },
    { key: 'created',      label: 'Created',      sort: 'date',   filter: 'text',   default: false },
  ];

  const rowData = rows.map(r => ({
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
    account_name: r.account_name ?? '',
    account_id: r.account_id ?? '',
    total: r.total_price != null ? Number(r.total_price) : '',
    total_display: r.total_price != null ? fmtDollar(r.total_price) : '',
    valid_until: r.valid_until ?? '',
    updated: (r.updated_at ?? '').slice(0, 10),
    created: (r.created_at ?? '').slice(0, 10),
  }));

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

  const body = html`
    <section class="card">
      <div class="card-header">
        <h1 class="page-title">Quotes</h1>
        ${listToolbar({ id: 'quotes', count: rows.length, columns })}
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
                      data-opp_id="${escape(r.opp_id)}"
                      class="${(r.status === 'dead' || r.status === 'rejected' || r.status === 'expired') ? 'row-muted' : ''}"
                      ${raw(rowDataAttrs(columns, r))}>
                    <td class="col-open" data-col="open">
                      <a class="row-open-link" href="/opportunities/${escape(r.opp_id)}/quotes/${escape(r.id)}" title="Open quote" aria-label="Open quote">\u2197</a>
                    </td>
                    <td class="col-number" data-col="number"><a href="/opportunities/${escape(r.opp_id)}/quotes/${escape(r.id)}"><code>${escape(r.number)}</code></a></td>
                    <td class="col-revision" data-col="revision">${escape(r.revision)}</td>
                    <td class="col-type_label" data-col="type_label">${escape(r.type_label)}</td>
                    <td class="col-title" data-col="title">
                      ${ieText('title', r.title)}
                    </td>
                    <td class="col-opp_number" data-col="opp_number"><a href="/opportunities/${escape(r.opp_id)}"><code>${escape(r.opp_number_display)}</code> ${escape(r.opp_title)}</a></td>
                    <td class="col-account_name" data-col="account_name">
                      ${r.account_id
                        ? html`<a href="/accounts/${escape(r.account_id)}">${escape(r.account_name)}</a>`
                        : html`<span class="muted">\u2014</span>`}
                    </td>
                    <td class="col-status_label" data-col="status_label"><span class="pill ${statusPillClass(r.status)}">${escape(r.status_label)}</span></td>
                    <td class="col-total num" data-col="total">${escape(r.total_display)}</td>
                    <td class="col-valid_until" data-col="valid_until">
                      ${ieText('valid_until', r.valid_until, { inputType: 'date' })}
                    </td>
                    <td class="col-updated" data-col="updated"><small class="muted">${escape(r.updated)}</small></td>
                    <td class="col-created" data-col="created"><small class="muted">${escape(r.created)}</small></td>
                  </tr>
                `)}
              </tbody>
            </table>
          </div>
          <script>${raw(listScript('pms.quotes.v1', 'updated', 'desc', {
            // Default view: just the "live" statuses — Draft, Issued,
            // Expired. Hides Accepted/Rejected/Dead so the main list is
            // the set of quotes that still need attention. Users can
            // clear the Status column filter to widen.
            status_label: { values: ['Draft', 'Issued', 'Expired'] },
          }))}</script>
          <script>${raw(listInlineEditScript('/opportunities/:opp_id/quotes/:id/patch'))}</script>
        `}
    </section>
  `;

  return htmlResponse(
    layout('Quotes', body, {
      user,
      env: data?.env,
      activeNav: '/quotes',
      flash: readFlash(url),
      breadcrumbs: [
        { label: 'Quotes' },
      ],
    })
  );
}
