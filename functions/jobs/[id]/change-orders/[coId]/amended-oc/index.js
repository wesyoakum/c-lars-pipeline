// functions/jobs/[id]/change-orders/[coId]/amended-oc/index.js
//
// GET /jobs/:id/change-orders/:coId/amended-oc — Amended OC document-
// layout preview.
//
// Mirrors the OC page's 5-card layout but sources line items, terms,
// totals, and governance from the accepting CO quote (the quote whose
// change_order_id = this CO and whose status = 'accepted'). The only
// editable fields are the amended OC number and an optional notes
// string, captured in the header card before issuance.
//
// Two states:
//   - CO status='won' and amended_oc not yet issued: input + Issue
//     button. POSTs to /jobs/:id/change-orders/:coId/issue-amended-oc.
//   - amended_oc issued: read-only mirror.

import { all, one } from '../../../../../lib/db.js';
import { layout, htmlResponse, html, raw, escape } from '../../../../../lib/layout.js';
import { redirectWithFlash, readFlash } from '../../../../../lib/http.js';
import { templateManagerHtml } from '../../../../../lib/template-catalog.js';
import { getQuoteDocData } from '../../../../../lib/doc-generate.js';

const CO_STATUS_LABELS = {
  drafted: 'Drafted',
  submitted: 'Submitted',
  under_revision: 'Under revision',
  won: 'Won',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

function statusPillClass(s) {
  if (s === 'won') return 'pill-green';
  if (s === 'rejected' || s === 'cancelled') return 'pill-red';
  if (s === 'submitted') return 'pill-yellow';
  return '';
}

function fmtTimestamp(iso) {
  if (!iso) return '';
  return iso.slice(0, 16).replace('T', ' ');
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
            j.number AS job_number, j.job_type, j.oc_number,
            o.id AS opp_id, o.number AS opp_number, o.title AS opp_title,
            a.id AS account_id, a.name AS account_name,
            amend_user.display_name AS amended_oc_issued_by_name
       FROM change_orders co
       LEFT JOIN jobs j               ON j.id = co.job_id
       LEFT JOIN opportunities o      ON o.id = co.opportunity_id
       LEFT JOIN accounts a           ON a.id = o.account_id
       LEFT JOIN users amend_user     ON amend_user.id = co.amended_oc_issued_by_user_id
      WHERE co.id = ? AND co.job_id = ?`,
    [coId, jobId]
  );
  if (!co) return redirectWithFlash(`/jobs/${jobId}`, 'Change order not found.', 'error');

  // Find the accepted quote on this CO (the one whose acceptance
  // triggered the amended OC). Falls back to the most-recent issued
  // quote so the page still renders if the user is previewing before
  // acceptance.
  const sourceQuote = await one(
    env.DB,
    `SELECT id, number, revision, status FROM quotes
      WHERE change_order_id = ?
        AND status IN ('accepted', 'issued', 'revision_issued')
      ORDER BY (status = 'accepted') DESC, updated_at DESC
      LIMIT 1`,
    [coId]
  );

  const docData = sourceQuote
    ? await getQuoteDocData(env, sourceQuote.id)
    : null;

  const generatedDocs = await all(
    env.DB,
    `SELECT id, original_filename, size_bytes, kind, uploaded_at
       FROM documents
      WHERE job_id = ? AND kind = 'oc_pdf'
      ORDER BY uploaded_at DESC`,
    [jobId]
  );
  const highlightDocId = url.searchParams.get('download') || '';

  const isIssued = !!co.amended_oc_issued_at;
  const canIssue = !isIssued && co.status === 'won';
  const newRev = co.amended_oc_revision || 1;
  const defaultAmendedOcNumber =
    co.amended_oc_number || `OC-${co.number}`;

  const jobTypeLabel = {
    spares: 'Spares', service: 'Service', eps: 'EPS', refurb: 'Refurbishment',
  }[(co.job_type || '').split(',')[0].trim()] || 'Job';

  // ── 1. Header card ────────────────────────────────────────────────
  const headerSection = html`
    <section class="card">
      <div class="card-header">
        <div>
          <h1 class="page-title">
            ${escape(isIssued ? co.amended_oc_number : 'New Amended OC')}
            <span class="pill ${statusPillClass(co.status)}">${escape(CO_STATUS_LABELS[co.status] ?? co.status)}</span>
            ${docData ? html`<span class="header-value">${escape(docData.quoteTotal || '')}</span>` : ''}
          </h1>
          <p class="muted" style="margin:0.15rem 0 0;font-size:0.85em">
            Amended Order Confirmation · ${escape(jobTypeLabel)} · <a href="/jobs/${escape(jobId)}/change-orders/${escape(coId)}">${escape(co.number)}</a>
            ${co.oc_number ? html` · supersedes baseline OC <strong>${escape(co.oc_number)}</strong>` : ''}
            ${sourceQuote ? html` · sourced from <a href="/opportunities/${escape(co.opp_id)}/quotes/${escape(sourceQuote.id)}">${escape(sourceQuote.number)} ${escape(sourceQuote.revision || '')}</a>` : ''}
          </p>
        </div>
        <div class="header-actions-stack">
          <a class="back-link" href="/jobs/${escape(jobId)}/change-orders/${escape(coId)}">\u2190 Change Order</a>
        </div>
      </div>

      ${isIssued
        ? html`
          <div class="governance-snapshot">
            <p class="muted" style="margin:0">
              Issued ${escape(fmtTimestamp(co.amended_oc_issued_at))}
              by ${escape(co.amended_oc_issued_by_name || 'unknown')}
              · Amended OC ${escape(co.amended_oc_number || '')}
              · Rev ${escape(String(newRev))}
              ${co.accepted_po_number ? html` · PO ${escape(co.accepted_po_number)}` : ''}
              ${docData ? html`
                · T&amp;Cs ${escape(docData.tcRevision || '\u2014')}
                · Warranty ${escape(docData.warrantyRevision || '\u2014')}
                · Rate Sched ${escape(docData.rateScheduleRevision || '\u2014')}
                · SOP ${escape(docData.sopRevision || '\u2014')}
              ` : ''}
            </p>
          </div>` : ''}

      ${generatedDocs.length
        ? html`
          <div style="padding:0.5rem 1rem 0.75rem;border-top:1px solid var(--border)">
            <p class="muted" style="margin:0 0 0.35rem;font-size:0.8em;font-weight:600">Generated Documents</p>
            ${generatedDocs.map(d => html`
              <span class="gen-doc-row ${d.id === highlightDocId ? 'gen-doc-highlight' : ''}">
                <a href="/documents/${escape(d.id)}/download" class="gen-doc-link" target="_blank">
                  \uD83D\uDCC4 ${escape(d.original_filename)}
                </a>
              </span>
            `)}
          </div>` : ''}
    </section>
  `;

  // ── 2. Banner card ────────────────────────────────────────────────
  const bannerCard = html`
    <section class="card quote-doc-card quote-doc-first quote-banner">
      <div class="quote-banner-inner">
        <div>
          <h2 class="quote-banner-title">AMENDED ORDER CONFIRMATION</h2>
          <p class="quote-banner-type">${escape(jobTypeLabel)} · CO ${escape(co.number)}</p>
        </div>
        <img src="/img/logo-black.png" alt="C-LARS" class="quote-banner-logo">
      </div>
    </section>
  `;

  // ── 3. Details card ───────────────────────────────────────────────
  const detailsSection = !docData
    ? html`
        <section class="card quote-doc-card quote-doc-last">
          <p class="muted">No accepted change-order quote yet — accept a CO quote first to generate the Amended OC.</p>
        </section>` : html`
    <section class="card quote-doc-card">
      <div class="quote-meta-grid quote-meta-equal">
        <div class="quote-meta-left">
          <div class="client-info">
            <p style="margin:0"><strong><a href="/accounts/${escape(co.account_id)}">${escape(docData.clientName || co.account_name || '')}</a></strong></p>
            ${docData.clientAddress
              ? html`<pre class="addr" style="margin:0.35rem 0 0">${escape(docData.clientAddress)}</pre>`
              : html`<p class="muted" style="margin:0.35rem 0 0">No billing address selected</p>`}
            ${docData.contactName ? html`
              <p style="margin:0.35rem 0 0;font-size:0.9em">
                ${escape(docData.contactName)}${docData.contactTitle ? html` · ${escape(docData.contactTitle)}` : ''}
                ${docData.contactEmail ? html`<br><span class="muted">${escape(docData.contactEmail)}</span>` : ''}
              </p>` : ''}
          </div>
          ${co.description ? html`
            <div style="margin-top:0.75rem;padding:0.5rem 0.7rem;background:var(--bg-alt);border-radius:var(--radius)">
              <strong style="font-size:0.85em">Scope change</strong>
              <p style="white-space:pre-wrap;margin:0.25rem 0 0;font-size:0.9em">${escape(co.description)}</p>
            </div>` : ''}
        </div>
        <div class="quote-meta-right">
          ${canIssue ? html`
            <form method="post" action="/jobs/${escape(jobId)}/change-orders/${escape(coId)}/issue-amended-oc" class="amended-oc-issue-form">
              <table class="quote-meta-table">
                <tr>
                  <td class="meta-label">Amended OC No:</td>
                  <td><input type="text" name="amended_oc_number" value="${escape(defaultAmendedOcNumber)}" class="meta-input" required style="width:100%"></td>
                </tr>
                <tr>
                  <td class="meta-label">Date:</td>
                  <td><span class="muted">Stamped at issuance</span></td>
                </tr>
                <tr>
                  <td class="meta-label">Revision:</td>
                  <td><strong>${escape(String(newRev))}</strong></td>
                </tr>
                <tr>
                  <td class="meta-label">Supersedes:</td>
                  <td>${co.oc_number ? html`Baseline OC <strong>${escape(co.oc_number)}</strong>` : html`<span class="muted">\u2014</span>`}</td>
                </tr>
                <tr>
                  <td class="meta-label">CO PO:</td>
                  <td>${escape(co.accepted_po_number || '\u2014')}</td>
                </tr>
              </table>
              <label style="display:block;margin-top:0.5rem">
                Notes
                <input type="text" name="notes" placeholder="Reason for amendment (optional)" class="meta-input" style="width:100%">
              </label>
              <div style="margin-top:0.75rem;display:flex;justify-content:flex-end">
                <button class="btn primary" type="submit">Issue Amended OC</button>
              </div>
            </form>
          ` : html`
            <table class="quote-meta-table">
              <tr>
                <td class="meta-label">Amended OC No:</td>
                <td><strong>${escape(co.amended_oc_number || '\u2014')}</strong></td>
              </tr>
              <tr>
                <td class="meta-label">Date:</td>
                <td>${escape((co.amended_oc_issued_at || '').slice(0, 10) || '\u2014')}</td>
              </tr>
              <tr>
                <td class="meta-label">Revision:</td>
                <td>${escape(String(newRev))}</td>
              </tr>
              <tr>
                <td class="meta-label">Supersedes:</td>
                <td>${co.oc_number ? html`Baseline OC <strong>${escape(co.oc_number)}</strong>` : html`<span class="muted">\u2014</span>`}</td>
              </tr>
              <tr>
                <td class="meta-label">CO PO:</td>
                <td>${escape(co.accepted_po_number || '\u2014')}</td>
              </tr>
            </table>
          `}
        </div>
      </div>

      ${docData.quoteTitle ? html`
        <p style="margin:0.75rem 0 0"><strong>Title:</strong> ${escape(docData.quoteTitle)}</p>
      ` : ''}
      ${docData.description ? html`
        <p style="margin:0.5rem 0 0;white-space:pre-wrap">${escape(docData.description)}</p>
      ` : ''}
    </section>
  `;

  // ── 4. Line items card ────────────────────────────────────────────
  const linesSection = docData ? html`
    <section class="card quote-doc-card">
      <div class="card-header">
        <h2>Line items (modified scope)</h2>
        <div class="header-actions">
          <span class="header-value">${escape(docData.quoteSubtotal || '')} subtotal</span>
        </div>
      </div>
      <p class="muted" style="margin:0 0 0.5rem;font-size:0.85em">
        Inherited from <a href="/opportunities/${escape(co.opp_id)}/quotes/${escape(sourceQuote?.id || '')}">the accepted change-order quote</a>. The Amended OC supersedes the baseline OC's scope and pricing.
      </p>

      <table class="data compact quote-lines-table">
        <thead>
          <tr>
            <th class="col-num">#</th>
            <th class="col-item">Item</th>
            <th class="num col-qty">Qty</th>
            <th class="col-unit">Unit</th>
            <th class="num col-price">Unit price</th>
            <th class="num col-ext">Price ext</th>
          </tr>
        </thead>
        <tbody>
          ${(docData.lines || []).map((l, i) => html`
            <tr>
              <td class="col-num">${i + 1}</td>
              <td class="col-item">
                <strong>${escape(l.title || '')}</strong>
                ${l.note ? html`<div class="muted" style="font-size:0.85em">${escape(l.note)}</div>` : ''}
                ${l.partNumber ? html`<div class="muted" style="font-size:0.8em">P/N: ${escape(l.partNumber)}</div>` : ''}
              </td>
              <td class="num col-qty">${escape(l.quantity || '')}</td>
              <td class="col-unit">${escape(l.unit || '')}</td>
              <td class="num col-price">${escape(l.unitPrice || '')}</td>
              <td class="num col-ext">${escape(l.amount || '')}</td>
            </tr>
          `)}
          <tr>
            <td colspan="5" class="num"><strong>Subtotal</strong></td>
            <td class="num"><strong>${escape(docData.quoteSubtotal || '')}</strong></td>
          </tr>
          ${docData.hasDiscount ? html`
            <tr>
              <td colspan="5" class="num">${escape(docData.quoteDiscountDescription || 'Discount')}</td>
              <td class="num">-${escape(docData.quoteDiscountAmount || '')}</td>
            </tr>` : ''}
          <tr>
            <td colspan="5" class="num">Tax</td>
            <td class="num">${escape(docData.quoteTax || '')}</td>
          </tr>
          <tr>
            <td colspan="5" class="num"><strong>Total</strong></td>
            <td class="num"><strong>${escape(docData.quoteTotal || '')}</strong></td>
          </tr>
        </tbody>
      </table>
    </section>
  ` : '';

  // ── 5. Footer card ────────────────────────────────────────────────
  const footerSection = docData ? html`
    <section class="card quote-doc-card quote-doc-last">
      ${docData.quoteNotes ? html`
        <label>
          <strong>Notes</strong>
          <p style="white-space:pre-wrap;margin:0.25rem 0 0">${escape(docData.quoteNotes)}</p>
        </label>` : ''}
      ${docData.quoteTerms ? html`
        <div style="margin-top:0.75rem">
          <strong>Payment terms</strong>
          <p style="white-space:pre-wrap;margin:0.25rem 0 0">${escape(docData.quoteTerms)}</p>
        </div>` : ''}
      ${docData.deliveryTerms ? html`
        <div style="margin-top:0.75rem">
          <strong>Delivery terms</strong>
          <p style="white-space:pre-wrap;margin:0.25rem 0 0">${escape(docData.deliveryTerms)}</p>
        </div>` : ''}
      ${docData.delivery ? html`
        <p style="margin-top:0.5rem"><strong>Delivery estimate:</strong> ${escape(docData.delivery)}</p>` : ''}
    </section>
  ` : '';

  const templatesSection = html`
    <section class="card">
      <h2>Document Templates</h2>
      ${raw(templateManagerHtml('oc-amended'))}
    </section>
  `;

  const body = headerSection + bannerCard + detailsSection + linesSection + footerSection + templatesSection;

  return htmlResponse(
    layout(`Amended OC ${co.amended_oc_number || co.number}`, body, {
      user,
      env: data?.env,
      activeNav: '/jobs',
      flash: readFlash(url),
      breadcrumbs: [
        { label: 'Jobs', href: '/jobs' },
        { label: escape(co.job_number), href: `/jobs/${jobId}` },
        { label: escape(co.number), href: `/jobs/${jobId}/change-orders/${coId}` },
        { label: 'Amended OC' },
      ],
    })
  );
}
