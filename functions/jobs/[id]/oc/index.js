// functions/jobs/[id]/oc/index.js
//
// GET /jobs/:id/oc — Order Confirmation document-layout preview.
//
// Mirrors the quote detail page's 5-card layout (header / banner /
// details / line items / footer) so the OC form looks like the OC
// document the customer will receive. The line items, terms, totals,
// and governance snapshot all derive from the most-recent accepted
// quote on the parent opp; the only editable fields are OC number and
// customer PO number, captured in the header card before issuance.
//
// Two states:
//   - Not yet issued (job.oc_issued_at IS NULL): inputs for OC# / PO#
//     plus an "Issue OC" button. POSTs to /jobs/:id/issue-oc which
//     handles the actual issuance, PDF generation, and stage advance.
//   - Issued: read-only mirror of the document, governance snapshot
//     locked, generated PDF list, link to revise via amended OC if
//     applicable.

import { all, one } from '../../../lib/db.js';
import { layout, htmlResponse, html, raw, escape } from '../../../lib/layout.js';
import { redirectWithFlash, readFlash } from '../../../lib/http.js';
import { templateManagerHtml, templateTypeForOC } from '../../../lib/template-catalog.js';
import { getOcDocData } from '../../../lib/doc-generate.js';
import { renderJobTabs } from '../../../lib/job-tabs.js';

const STATUS_LABELS = {
  created: 'Created',
  awaiting_ntp: 'Awaiting NTP',
  handed_off: 'Handed Off',
  cancelled: 'Cancelled',
  complete: 'Complete',
};

function statusPillClass(s) {
  if (s === 'handed_off' || s === 'complete') return 'pill-green';
  if (s === 'cancelled') return 'pill-red';
  if (s === 'awaiting_ntp') return 'pill-yellow';
  return '';
}

function fmtTimestamp(iso) {
  if (!iso) return '';
  return iso.slice(0, 16).replace('T', ' ');
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function onRequestGet(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const jobId = params.id;

  const job = await one(
    env.DB,
    `SELECT j.*,
            o.id AS opp_id, o.number AS opp_number, o.title AS opp_title,
            o.transaction_type, o.customer_po_number AS opp_po_number,
            a.id AS account_id, a.name AS account_name,
            oc_user.display_name AS oc_issued_by_name
       FROM jobs j
       LEFT JOIN opportunities o ON o.id = j.opportunity_id
       LEFT JOIN accounts a ON a.id = o.account_id
       LEFT JOIN users oc_user ON oc_user.id = j.oc_issued_by_user_id
      WHERE j.id = ?`,
    [jobId]
  );
  if (!job) return redirectWithFlash('/jobs', 'Job not found.', 'error');

  // Build the OC doc-data payload (line items, terms, totals,
  // governance) by reusing the same helper that fills the OC template.
  // Returns null if there is no accepted/issued quote yet — in that
  // case we show a friendly empty state instead of crashing.
  const docData = await getOcDocData(env, jobId);

  // Pull the accepting quote separately so we can show its number and
  // link to it from the OC page.
  const sourceQuote = job.opportunity_id
    ? await one(
        env.DB,
        `SELECT id, number, revision, status FROM quotes
          WHERE opportunity_id = ?
            AND status IN ('accepted', 'issued', 'revision_issued')
          ORDER BY (status = 'accepted') DESC, updated_at DESC
          LIMIT 1`,
        [job.opportunity_id]
      )
    : null;

  // Generated OC PDFs for the documents strip.
  const generatedDocs = await all(
    env.DB,
    `SELECT id, original_filename, size_bytes, kind, uploaded_at
       FROM documents
      WHERE job_id = ? AND kind IN ('oc_pdf', 'oc_docx')
      ORDER BY uploaded_at DESC`,
    [jobId]
  );
  const highlightDocId = url.searchParams.get('highlight') || '';

  const isIssued = !!job.oc_issued_at;
  const canIssue = !isIssued;
  const canGenerate = !!sourceQuote;
  const jobType = (job.job_type || '').split(',')[0].trim() || 'spares';
  const jobTypeLabel = {
    spares: 'Spares', service: 'Service', eps: 'EPS', refurb: 'Refurbishment',
  }[jobType] || jobType;
  const ocTemplateKey = templateTypeForOC(jobType);

  const defaultOcNumber =
    job.oc_number || (sourceQuote ? `OC-${sourceQuote.number}` : '');
  const defaultPoNumber = job.customer_po_number || job.opp_po_number || '';

  // ── 1. Header card ────────────────────────────────────────────────
  const headerSection = html`
    <section class="card">
      <div class="card-header">
        <div>
          <h1 class="page-title">
            ${escape(isIssued ? job.oc_number || 'OC' : 'New OC')}
            <span class="pill ${statusPillClass(job.status)}">${escape(STATUS_LABELS[job.status] ?? job.status)}</span>
            ${docData ? html`<span class="header-value">${escape(docData.quoteTotal || '')}</span>` : ''}
          </h1>
          <p class="muted" style="margin:0.15rem 0 0;font-size:0.85em">
            Order Confirmation · ${escape(jobTypeLabel)} · <a href="/jobs/${escape(jobId)}">${escape(job.number)}</a>
            ${sourceQuote ? html` · sourced from <a href="/opportunities/${escape(job.opp_id)}/quotes/${escape(sourceQuote.id)}">${escape(sourceQuote.number)} ${escape(sourceQuote.revision || '')}</a>` : ''}
          </p>
        </div>
        <div class="header-actions-stack">
          <a class="back-link" href="/jobs/${escape(jobId)}">\u2190 Job</a>
          <div class="header-actions">
            ${canIssue ? html`
              <button class="btn primary" type="submit" form="oc-issue-form">Issue OC</button>
            ` : ''}
            ${isIssued ? html`
              <form method="post" action="/jobs/${escape(jobId)}/revise-oc" class="inline-form"
                    onsubmit="return confirm('Bump OC to revision ${escape(String((job.oc_revision || 1) + 1))} for re-issue?');">
                <button class="btn" type="submit">Revise</button>
              </form>
            ` : ''}
            ${canGenerate ? html`
              <form method="post" action="/jobs/${escape(jobId)}/generate-oc-pdf" class="inline-form">
                <button class="btn" type="submit">Generate PDF</button>
              </form>
              <form method="post" action="/jobs/${escape(jobId)}/generate-oc-docx" class="inline-form">
                <button class="btn" type="submit">Download Word</button>
              </form>
            ` : ''}
          </div>
        </div>
      </div>

      ${isIssued
        ? html`
          <div class="governance-snapshot">
            <p class="muted" style="margin:0">
              Issued ${escape(fmtTimestamp(job.oc_issued_at))}
              by ${escape(job.oc_issued_by_name || 'unknown')}
              · OC ${escape(job.oc_number || '')}
              · PO ${escape(job.customer_po_number || job.opp_po_number || '\u2014')}
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
                  ${d.kind === 'oc_pdf' ? '\uD83D\uDCC4' : '\uD83D\uDCDD'} ${escape(d.original_filename)}
                  <span class="muted">(${formatSize(d.size_bytes)})</span>
                </a>
                <form method="post" action="/documents/${escape(d.id)}/delete" style="display:inline" onsubmit="return confirm('Delete this document?')">
                  <input type="hidden" name="return_to" value="/jobs/${escape(jobId)}/oc">
                  <button type="submit" class="gen-doc-delete" title="Delete">\u00d7</button>
                </form>
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
          <h2 class="quote-banner-title">ORDER CONFIRMATION</h2>
          <p class="quote-banner-type">${escape(jobTypeLabel)}</p>
        </div>
        <img src="/img/logo-black.png" alt="C-LARS" class="quote-banner-logo">
      </div>
    </section>
  `;

  // ── 3. Details card ───────────────────────────────────────────────
  // Issuance form lives here when the OC hasn't been issued yet — OC#
  // and PO# are the only editable fields. After issuance the same
  // fields render as read-only meta rows.
  const detailsSection = !docData
    ? html`
        <section class="card quote-doc-card quote-doc-last">
          <p class="muted">No accepted or issued quote on the parent opportunity yet.
          The OC inherits its line items, terms, and totals from the accepted quote — once a
          quote is accepted, this page will populate.</p>
        </section>` : html`
    <section class="card quote-doc-card">
      <div class="quote-meta-grid quote-meta-equal">
        <div class="quote-meta-left">
          <div class="client-info">
            <p style="margin:0"><strong><a href="/accounts/${escape(job.account_id)}">${escape(docData.clientName || job.account_name || '')}</a></strong></p>
            ${docData.clientAddress
              ? html`<pre class="addr" style="margin:0.35rem 0 0">${escape(docData.clientAddress)}</pre>`
              : html`<p class="muted" style="margin:0.35rem 0 0">No billing address selected</p>`}
            ${docData.contactName ? html`
              <p style="margin:0.35rem 0 0;font-size:0.9em">
                ${escape(docData.contactName)}${docData.contactTitle ? html` · ${escape(docData.contactTitle)}` : ''}
                ${docData.contactEmail ? html`<br><span class="muted">${escape(docData.contactEmail)}</span>` : ''}
              </p>` : ''}
          </div>
        </div>
        <div class="quote-meta-right">
          ${canIssue ? html`
            <form method="post" action="/jobs/${escape(jobId)}/issue-oc" id="oc-issue-form">
              <table class="quote-meta-table">
                <tr>
                  <td class="meta-label">OC No:</td>
                  <td><input type="text" name="oc_number" value="${escape(defaultOcNumber)}" class="meta-input" required style="width:100%"></td>
                </tr>
                <tr>
                  <td class="meta-label">Date:</td>
                  <td><span class="muted">Stamped at issuance</span></td>
                </tr>
                <tr>
                  <td class="meta-label">Customer PO:</td>
                  <td><input type="text" name="customer_po_number" value="${escape(defaultPoNumber)}" class="meta-input" placeholder="(optional)" style="width:100%"></td>
                </tr>
                <tr>
                  <td class="meta-label">Source Quote:</td>
                  <td>${sourceQuote ? html`<a href="/opportunities/${escape(job.opp_id)}/quotes/${escape(sourceQuote.id)}">${escape(sourceQuote.number)} ${escape(sourceQuote.revision || '')}</a>` : html`<span class="muted">\u2014</span>`}</td>
                </tr>
              </table>
            </form>
          ` : html`
            <table class="quote-meta-table">
              <tr>
                <td class="meta-label">OC No:</td>
                <td><strong>${escape(job.oc_number || '\u2014')}</strong></td>
              </tr>
              <tr>
                <td class="meta-label">Date:</td>
                <td>${escape((job.oc_issued_at || '').slice(0, 10) || '\u2014')}</td>
              </tr>
              <tr>
                <td class="meta-label">Customer PO:</td>
                <td>${escape(job.customer_po_number || job.opp_po_number || '\u2014')}</td>
              </tr>
              <tr>
                <td class="meta-label">Source Quote:</td>
                <td>${sourceQuote ? html`<a href="/opportunities/${escape(job.opp_id)}/quotes/${escape(sourceQuote.id)}">${escape(sourceQuote.number)} ${escape(sourceQuote.revision || '')}</a>` : html`<span class="muted">\u2014</span>`}</td>
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
        <h2>Line items</h2>
        <div class="header-actions">
          <span class="header-value">${escape(docData.quoteSubtotal || '')} subtotal</span>
        </div>
      </div>
      <p class="muted" style="margin:0 0 0.5rem;font-size:0.85em">
        Inherited from <a href="/opportunities/${escape(job.opp_id)}/quotes/${escape(sourceQuote?.id || '')}">the accepted quote</a>. Line items, prices, and totals are locked when the OC is issued.
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
          ${(docData.options || []).length ? html`
            <tr><td colspan="6" style="padding-top:0.5rem"><strong>Options</strong></td></tr>
            ${docData.options.map((l, i) => html`
              <tr class="line-option">
                <td class="col-num">O${i + 1}<br><span class="pill" style="font-size:0.7em">OPT</span></td>
                <td class="col-item">
                  <strong>${escape(l.title || '')}</strong>
                  ${l.note ? html`<div class="muted" style="font-size:0.85em">${escape(l.note)}</div>` : ''}
                </td>
                <td class="num col-qty">${escape(l.quantity || '')}</td>
                <td class="col-unit">${escape(l.unit || '')}</td>
                <td class="num col-price">${escape(l.unitPrice || '')}</td>
                <td class="num col-ext">${escape(l.amount || '')}</td>
              </tr>
            `)}` : ''}
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

  // ── Templates section ─────────────────────────────────────────────
  const templatesSection = html`
    <section class="card">
      <h2>Document Templates</h2>
      ${raw(templateManagerHtml(ocTemplateKey))}
    </section>
  `;

  const tabs = renderJobTabs(jobId, job.job_type, 'oc');
  const body = tabs + headerSection + bannerCard + detailsSection + linesSection + footerSection + templatesSection;

  return htmlResponse(
    layout(`OC ${job.oc_number || job.number}`, body, {
      user,
      env: data?.env,
      activeNav: '/jobs',
      flash: readFlash(url),
      breadcrumbs: [
        { label: 'Jobs', href: '/jobs' },
        { label: escape(job.number), href: `/jobs/${jobId}` },
        { label: 'OC' },
      ],
    })
  );
}
