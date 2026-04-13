// functions/quotes/index.js
//
// GET /quotes — list all quotes across all opportunities.
// Simple table with search, filters, and links back to the quote editor.

import { all } from '../lib/db.js';
import { layout, htmlResponse, html, raw, escape } from '../lib/layout.js';
import { readFlash } from '../lib/http.js';
import { fmtDollar } from '../lib/pricing.js';
import { QUOTE_TYPE_LABELS, QUOTE_STATUS_LABELS } from '../lib/validators.js';

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

  const rowData = rows.map(r => ({
    id: r.id,
    opp_id: r.opportunity_id,
    number: r.number ?? '',
    revision: r.revision ?? '',
    type_label: QUOTE_TYPE_LABELS[r.quote_type] ?? r.quote_type ?? '',
    status_label: QUOTE_STATUS_LABELS[r.status] ?? r.status ?? '',
    status: r.status,
    title: r.title ?? '',
    opp_number: r.opp_number ?? '',
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
      case 'rejected': case 'expired': case 'dead': return 'pill-locked';
      default: return '';
    }
  }

  const body = html`
    <section class="card">
      <div class="card-header">
        <h1 class="page-title">Quotes</h1>
        <div class="toolbar-right">
          <div class="search-expand">
            <label class="search-icon" for="q-quicksearch">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8.5" cy="8.5" r="5.5"/><line x1="13" y1="13" x2="18" y2="18"/></svg>
            </label>
            <input type="search" id="q-quicksearch" data-role="quicksearch" placeholder="Search...">
          </div>
          <span class="muted" data-role="count" style="font-size:0.8em;white-space:nowrap">${rows.length}</span>
        </div>
      </div>

      ${rows.length === 0
        ? html`<p class="muted">No quotes yet. Create one from an opportunity.</p>`
        : html`
          <table class="data" id="quotes-table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Rev</th>
                <th>Type</th>
                <th>Title</th>
                <th>Opportunity</th>
                <th>Account</th>
                <th>Status</th>
                <th class="num">Total</th>
                <th>Valid until</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              ${rowData.map(r => html`
                <tr data-search="${escape(r.number)} ${escape(r.title)} ${escape(r.opp_number)} ${escape(r.opp_title)} ${escape(r.account_name)} ${escape(r.type_label)} ${escape(r.status_label)}">
                  <td><a href="/opportunities/${escape(r.opp_id)}/quotes/${escape(r.id)}"><code>${escape(r.number)}</code></a></td>
                  <td>${escape(r.revision)}</td>
                  <td>${escape(r.type_label)}</td>
                  <td x-data="qTitle('${escape(r.opp_id)}', '${escape(r.id)}', ${raw(JSON.stringify(r.title || ''))})">
                    <span x-show="!editing" @click="editing = true" style="cursor:pointer" :class="{ 'muted': !val }">
                      <span x-text="val || '(no title)'" style="border-bottom:1px dashed var(--border)"></span>
                    </span>
                    <input x-show="editing" x-cloak type="text" :value="val"
                           @blur="save($event.target.value)" @keydown.enter="save($event.target.value)"
                           @keydown.escape="editing = false"
                           x-ref="inp" style="width:100%;font:inherit;padding:0.15rem 0.3rem"
                           x-effect="if(editing) $nextTick(() => $refs.inp?.focus())">
                  </td>
                  <td><a href="/opportunities/${escape(r.opp_id)}"><code>${escape(r.opp_number)}</code> ${escape(r.opp_title)}</a></td>
                  <td>${r.account_id
                    ? html`<a href="/accounts/${escape(r.account_id)}">${escape(r.account_name)}</a>`
                    : html`<span class="muted">\u2014</span>`}</td>
                  <td><span class="pill ${statusPillClass(r.status)}">${escape(r.status_label)}</span></td>
                  <td class="num">${escape(r.total_display)}</td>
                  <td><small class="muted">${escape(r.valid_until)}</small></td>
                  <td><small class="muted">${escape(r.updated)}</small></td>
                </tr>
              `)}
            </tbody>
          </table>
          <script>
          (function() {
            var input = document.getElementById('q-quicksearch');
            var table = document.getElementById('quotes-table');
            var countEl = document.querySelector('[data-role="count"]');
            if (!input || !table) return;
            input.addEventListener('input', function() {
              var q = input.value.toLowerCase();
              var rows = table.querySelectorAll('tbody tr');
              var shown = 0;
              rows.forEach(function(row) {
                var text = (row.dataset.search || '').toLowerCase();
                var match = !q || text.indexOf(q) !== -1;
                row.style.display = match ? '' : 'none';
                if (match) shown++;
              });
              if (countEl) countEl.textContent = shown;
            });
          })();

          document.addEventListener('alpine:init', function() {
            Alpine.data('qTitle', function(oppId, quoteId, initial) {
              return {
                val: initial,
                editing: false,
                save: function(newVal) {
                  this.editing = false;
                  if (newVal === this.val) return;
                  this.val = newVal;
                  fetch('/opportunities/' + oppId + '/quotes/' + quoteId + '/patch', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ title: newVal }),
                  });
                },
              };
            });
          });
          </script>
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
