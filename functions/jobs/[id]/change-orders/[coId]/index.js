// functions/jobs/[id]/change-orders/[coId]/index.js
//
// GET /jobs/:id/change-orders/:coId — Change Order detail page.
//
// Shows: header with CO number, status, sequence; description (inline-
// editable); quotes linked to this CO with a "New CO quote" button;
// and — once a CO quote is accepted — an "Issue Amended OC" action.

import { all, one } from '../../../../lib/db.js';
import { layout, htmlResponse, html, raw, escape } from '../../../../lib/layout.js';
import { redirectWithFlash, readFlash } from '../../../../lib/http.js';
import { templateManagerHtml } from '../../../../lib/template-catalog.js';

const STATUS_LABELS = {
  drafted:         'Drafted',
  submitted:       'Submitted',
  under_revision:  'Under revision',
  won:             'Won',
  rejected:        'Rejected',
  cancelled:       'Cancelled',
};

function statusClass(s) {
  if (s === 'won') return 'pill-green';
  if (s === 'rejected' || s === 'cancelled') return 'pill-red';
  if (s === 'submitted') return 'pill-yellow';
  return '';
}

export async function onRequestGet(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const jobId = params.id;
  const coId = params.coId;

  const co = await one(
    env.DB,
    `SELECT co.*,
            j.number AS job_number, j.job_type,
            o.number AS opp_number, o.title AS opp_title, o.id AS opp_id,
            a.name   AS account_name, a.id AS account_id,
            amend_user.display_name AS amended_oc_issued_by_name,
            creator.display_name    AS created_by_name
       FROM change_orders co
       LEFT JOIN jobs j               ON j.id = co.job_id
       LEFT JOIN opportunities o      ON o.id = co.opportunity_id
       LEFT JOIN accounts a           ON a.id = o.account_id
       LEFT JOIN users amend_user     ON amend_user.id = co.amended_oc_issued_by_user_id
       LEFT JOIN users creator        ON creator.id = co.created_by_user_id
      WHERE co.id = ? AND co.job_id = ?`,
    [coId, jobId]
  );
  if (!co) return redirectWithFlash(`/jobs/${jobId}`, 'Change order not found.', 'error');

  const quotes = await all(
    env.DB,
    `SELECT id, number, revision, status, quote_type, total_price,
            submitted_at, created_at, updated_at
       FROM quotes
      WHERE change_order_id = ?
      ORDER BY created_at DESC`,
    [coId]
  );

  const events = await all(
    env.DB,
    `SELECT ae.event_type, ae.at, ae.summary,
            u.display_name AS user_name, u.email AS user_email
       FROM audit_events ae
       LEFT JOIN users u ON u.id = ae.user_id
      WHERE ae.entity_type = 'change_order' AND ae.entity_id = ?
      ORDER BY ae.at DESC LIMIT 100`,
    [coId]
  );

  const canCreateQuote = co.status !== 'cancelled' && co.status !== 'rejected';
  const canIssueAmended = co.status === 'won' && !co.amended_oc_issued_at;
  const canCancel = co.status !== 'cancelled' && co.status !== 'won';
  const defaultAmendedOcNumber = `OC-${co.number}`;

  const body = html`
    <section class="card" x-data="coInline('${escape(jobId)}', '${escape(coId)}')">
      <div class="card-header">
        <h1 class="page-title">
          ${escape(co.number)}
          <span class="muted" style="font-weight:normal;font-size:0.7em;margin-left:0.5rem">
            — Change Order #${escape(String(co.sequence))} on ${escape(co.job_number)}
          </span>
        </h1>
      </div>
      <p class="muted" style="margin:0.15rem 0 0.5rem">
        <span class="pill ${statusClass(co.status)}">${escape(STATUS_LABELS[co.status] ?? co.status)}</span>
        · <a href="/jobs/${escape(jobId)}">${escape(co.job_number)}</a>
        · <a href="/opportunities/${escape(co.opp_id)}">${escape(co.opp_number)} — ${escape(co.opp_title)}</a>
        · <a href="/accounts/${escape(co.account_id)}">${escape(co.account_name)}</a>
      </p>

      <div class="detail-grid">
        <div class="detail-pair" style="grid-column: 1/-1">
          <span class="detail-label">Description</span>
          <span class="detail-value">
            <span class="ie" data-field="description" data-type="textarea">
              <span class="ie-display ${co.description ? '' : 'muted'}">${escape(co.description || 'Add a scope-change summary')}</span>
              <span class="ie-raw" hidden>${escape(co.description || '')}</span>
            </span>
          </span>
        </div>
        ${co.accepted_at ? html`
          <div class="detail-pair">
            <span class="detail-label">Accepted</span>
            <span class="detail-value">${escape(co.accepted_at.slice(0, 10))}</span>
          </div>
          <div class="detail-pair">
            <span class="detail-label">Customer PO</span>
            <span class="detail-value">${escape(co.accepted_po_number || '—')}</span>
          </div>` : ''}
        ${co.amended_oc_number ? html`
          <div class="detail-pair">
            <span class="detail-label">Amended OC</span>
            <span class="detail-value">${escape(co.amended_oc_number)}</span>
          </div>
          <div class="detail-pair">
            <span class="detail-label">Amended OC Issued</span>
            <span class="detail-value">${co.amended_oc_issued_at ? html`${escape(co.amended_oc_issued_at.slice(0, 10))} by ${escape(co.amended_oc_issued_by_name || '—')}` : '—'}</span>
          </div>` : ''}
      </div>
    </section>

    <!-- Quotes on this CO -->
    <section class="card">
      <div class="card-header">
        <h2>Change-order quotes</h2>
        ${canCreateQuote ? html`
          <form method="post" action="/opportunities/${escape(co.opp_id)}/quotes" style="display:inline">
            <input type="hidden" name="change_order_id" value="${escape(coId)}">
            <input type="hidden" name="quote_type" value="${escape(primaryQuoteType(co.job_type))}">
            <button class="btn primary" type="submit">New CO quote</button>
          </form>` : ''}
      </div>
      ${quotes.length === 0
        ? html`<p class="muted">No quotes on this change order yet.</p>`
        : html`
          <table class="list">
            <thead>
              <tr>
                <th>Number</th><th>Rev</th><th>Status</th><th>Type</th>
                <th style="text-align:right">Total</th><th>Updated</th>
              </tr>
            </thead>
            <tbody>
              ${quotes.map(q => html`
                <tr>
                  <td><a href="/opportunities/${escape(co.opp_id)}/quotes/${escape(q.id)}">${escape(q.number)}</a></td>
                  <td>${escape(q.revision || '')}</td>
                  <td><span class="pill">${escape(q.status)}</span></td>
                  <td>${escape(q.quote_type || '')}</td>
                  <td style="text-align:right">${q.total_price != null ? '$' + Number(q.total_price).toFixed(2) : '—'}</td>
                  <td class="muted">${escape((q.updated_at || q.created_at || '').slice(0, 10))}</td>
                </tr>`)}
            </tbody>
          </table>`}
    </section>

    ${canIssueAmended ? html`
    <section class="card">
      <h2>Issue Amended OC</h2>
      <form method="post" action="/jobs/${escape(jobId)}/change-orders/${escape(coId)}/issue-amended-oc" class="action-form">
        <fieldset>
          <p class="muted" style="margin:0 0 0.5rem;font-size:0.85em">
            The change order is accepted. Issue the amended OC to authorize work on the modified scope.
          </p>
          <div><label class="field-label">Amended OC Number *</label><input type="text" name="amended_oc_number" value="${escape(defaultAmendedOcNumber)}" required></div>
          <div><label class="field-label">Notes</label><input type="text" name="notes" placeholder="Reason for amendment"></div>
          <button class="btn primary" type="submit" style="margin-top:0.5rem">Issue Amended OC</button>
        </fieldset>
      </form>
    </section>` : ''}

    ${canCancel ? html`
    <section class="card">
      <h2>Cancel change order</h2>
      <form method="post" action="/jobs/${escape(jobId)}/change-orders/${escape(coId)}/cancel"
            onsubmit="return confirm('Cancel this change order? Any draft quotes on it will remain but stage will revert to job in progress.');"
            class="action-form">
        <fieldset>
          <div><label class="field-label">Reason</label><input type="text" name="reason" placeholder="Optional"></div>
          <button class="btn danger" type="submit" style="margin-top:0.5rem">Cancel change order</button>
        </fieldset>
      </form>
    </section>` : ''}

    <!-- Template -->
    <section class="card">
      <h2>Document Templates</h2>
      ${raw(templateManagerHtml('quote-change-order'))}
      ${raw(templateManagerHtml('oc-amended'))}
    </section>

    <!-- History -->
    <section class="card">
      <h2>History</h2>
      ${events.length === 0
        ? html`<p class="muted">No history yet.</p>`
        : html`
          <ul class="activity">
            ${events.map(e => {
              const who = e.user_name ?? e.user_email ?? 'system';
              const when = e.at ? e.at.slice(0, 16).replace('T', ' ') : '';
              return html`<li>
                <div class="activity-head">
                  <strong>${escape(who)}</strong>
                  <span class="activity-type">${escape(e.event_type)}</span>
                  <span class="activity-when muted">${escape(when)}</span>
                </div>
                <div>${escape(e.summary ?? e.event_type)}</div>
              </li>`;
            })}
          </ul>`}
    </section>`;

  const scripts = html`<script>${raw(coInlineScript())}</script>`;

  return htmlResponse(
    layout(co.number, body + scripts, {
      user,
      env: data?.env,
      activeNav: '/jobs',
      flash: readFlash(url),
      breadcrumbs: [
        { label: 'Jobs', href: '/jobs' },
        { label: escape(co.job_number), href: `/jobs/${jobId}` },
        { label: escape(co.number) },
      ],
    })
  );
}

// Pick a reasonable default quote_type from the job_type for the CO
// quote form. Jobs with comma-separated types pick the first.
function primaryQuoteType(jobType) {
  const first = String(jobType || 'spares').split(',')[0].trim();
  if (first === 'refurb') return 'refurb_baseline';
  return first;
}

function coInlineScript() {
  return `
function coInline(jobId, coId) {
  const patchUrl = '/jobs/' + jobId + '/change-orders/' + coId + '/patch';
  return {
    init() {
      this.$el.querySelectorAll('.ie').forEach(el => {
        el.addEventListener('click', () => this.activate(el));
      });
    },
    activate(el) {
      if (el.querySelector('.ie-input')) return;
      const type = el.dataset.type;
      const display = el.querySelector('.ie-display');
      const rawEl = el.querySelector('.ie-raw');
      const currentValue = rawEl ? rawEl.textContent : (display.classList.contains('muted') ? '' : display.textContent.trim());

      let input;
      if (type === 'textarea') {
        input = document.createElement('textarea');
        input.className = 'ie-input';
        input.rows = 3;
        input.value = currentValue;
        input.addEventListener('blur', () => this.save(el, input));
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') this.deactivate(el, input);
        });
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.className = 'ie-input';
        input.value = currentValue;
        input.addEventListener('blur', () => this.save(el, input));
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); this.save(el, input); }
          if (e.key === 'Escape') this.deactivate(el, input);
        });
      }
      display.style.display = 'none';
      el.appendChild(input);
      input.focus();
      if (input.select) input.select();
    },
    async save(el, input) {
      const field = el.dataset.field;
      const value = input.value;
      this.deactivate(el, input);
      el.classList.add('ie-saving');
      try {
        const res = await fetch(patchUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ field, value }),
        });
        const data = await res.json();
        if (!data.ok) {
          el.classList.add('ie-error');
          setTimeout(() => el.classList.remove('ie-error'), 2000);
          return;
        }
        const display = el.querySelector('.ie-display');
        const rawEl = el.querySelector('.ie-raw');
        display.textContent = data.value || 'Add a scope-change summary';
        display.classList.toggle('muted', !data.value);
        if (rawEl) rawEl.textContent = data.value ?? '';
        el.classList.add('ie-saved');
        setTimeout(() => el.classList.remove('ie-saved'), 1200);
      } catch {
        el.classList.add('ie-error');
        setTimeout(() => el.classList.remove('ie-error'), 2000);
      } finally {
        el.classList.remove('ie-saving');
      }
    },
    deactivate(el, input) {
      const display = el.querySelector('.ie-display');
      display.style.display = '';
      input.remove();
    },
  };
}
`;
}
