// functions/jobs/[id]/ntp/index.js
//
// GET /jobs/:id/ntp — Notice to Proceed document-layout preview.
//
// EPS only. Mirrors the OC page's 5-card layout. NTP is a thin
// authorization document — no line items or terms negotiation; it just
// references the OC and confirms work may commence. The page reuses
// the OC doc-data payload (same client, same governance snapshot from
// the underlying accepted quote) but renders only the relevant
// sections.
//
// Two states:
//   - Not yet issued + status='awaiting_ntp': inputs for NTP# plus an
//     "Issue NTP" button. POSTs to /jobs/:id/issue-ntp.
//   - Issued: read-only mirror with NTP#, date, ref to OC.

import { all, one } from '../../../lib/db.js';
import { layout, htmlResponse, html, raw, escape } from '../../../lib/layout.js';
import { redirectWithFlash, readFlash } from '../../../lib/http.js';
import { ICON_PDF, ICON_DOCX } from '../../../lib/icons.js';
import { templateManagerHtml } from '../../../lib/template-catalog.js';
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
            o.transaction_type,
            a.id AS account_id, a.name AS account_name,
            ntp_user.display_name AS ntp_issued_by_name
       FROM jobs j
       LEFT JOIN opportunities o ON o.id = j.opportunity_id
       LEFT JOIN accounts a ON a.id = o.account_id
       LEFT JOIN users ntp_user ON ntp_user.id = j.ntp_issued_by_user_id
      WHERE j.id = ?`,
    [jobId]
  );
  if (!job) return redirectWithFlash('/jobs', 'Job not found.', 'error');

  if (!(job.job_type || '').split(',').includes('eps')) {
    return redirectWithFlash(
      `/jobs/${jobId}`,
      'NTP is only applicable to EPS jobs.',
      'error'
    );
  }

  const docData = await getOcDocData(env, jobId);

  const generatedDocs = await all(
    env.DB,
    `SELECT id, original_filename, size_bytes, kind, uploaded_at
       FROM documents
      WHERE job_id = ? AND kind IN ('ntp_pdf', 'ntp_docx')
      ORDER BY uploaded_at DESC`,
    [jobId]
  );
  const highlightDocId = url.searchParams.get('highlight') || '';

  const isIssued = !!job.ntp_issued_at;
  // Allow issuance whenever the NTP isn't currently stamped — covers
  // first-time (status=awaiting_ntp) and re-issue after a Revise
  // (status stays handed_off, ntp_issued_at cleared).
  const canIssue = !isIssued;
  const canGenerate = !!docData;
  const defaultNtpNumber = job.ntp_number || `NTP-${job.number}`;

  // ── 1. Header card ────────────────────────────────────────────────
  const headerSection = html`
    <section class="card">
      <div class="card-header">
        <div>
          <h1 class="page-title">
            ${escape(isIssued ? job.ntp_number || 'NTP' : 'New NTP')}
            <span class="pill ${statusPillClass(job.status)}">${escape(STATUS_LABELS[job.status] ?? job.status)}</span>
          </h1>
          <p class="muted" style="margin:0.15rem 0 0;font-size:0.85em">
            Notice to Proceed · EPS · <a href="/jobs/${escape(jobId)}">${escape(job.number)}</a>
            ${job.oc_number ? html` · references OC <strong>${escape(job.oc_number)}</strong>` : ''}
          </p>
        </div>
        <div class="header-actions-stack">
          <a class="back-link" href="/jobs/${escape(jobId)}">\u2190 Job</a>
          <div class="header-actions">
            ${canIssue ? html`
              <button class="btn primary" type="submit" form="ntp-issue-form">Issue NTP</button>
            ` : ''}
            ${isIssued ? html`
              <form method="post" action="/jobs/${escape(jobId)}/revise-ntp" class="inline-form"
                    onsubmit="return confirm('Bump NTP to revision ${escape(String((job.ntp_revision || 1) + 1))} for re-issue?');">
                <button class="btn" type="submit">Revise</button>
              </form>
            ` : ''}
            ${canGenerate ? html`
              <form method="post" action="/jobs/${escape(jobId)}/generate-ntp-pdf" class="inline-form">
                <button class="btn btn-icon-doc" type="submit" title="Generate NTP PDF" aria-label="Generate NTP PDF"
                        style="display:inline-flex;align-items:center;justify-content:center;padding:0.35rem 0.55rem">
                  ${raw(ICON_PDF)}
                </button>
              </form>
              <form method="post" action="/jobs/${escape(jobId)}/generate-ntp-docx" class="inline-form">
                <button class="btn btn-icon-doc" type="submit" title="Download NTP Word document" aria-label="Download NTP Word"
                        style="display:inline-flex;align-items:center;justify-content:center;padding:0.35rem 0.55rem">
                  ${raw(ICON_DOCX)}
                </button>
              </form>
            ` : ''}
          </div>
        </div>
      </div>

      ${isIssued
        ? html`
          <div class="governance-snapshot">
            <p class="muted" style="margin:0">
              Issued ${escape(fmtTimestamp(job.ntp_issued_at))}
              by ${escape(job.ntp_issued_by_name || 'unknown')}
              · NTP ${escape(job.ntp_number || '\u2014')}
              · OC ${escape(job.oc_number || '\u2014')}
            </p>
          </div>` : ''}

      ${generatedDocs.length
        ? html`
          <div style="padding:0.5rem 1rem 0.75rem;border-top:1px solid var(--border)">
            <p class="muted" style="margin:0 0 0.35rem;font-size:0.8em;font-weight:600">Generated Documents</p>
            ${generatedDocs.map(d => html`
              <span class="gen-doc-row ${d.id === highlightDocId ? 'gen-doc-highlight' : ''}">
                <a href="/documents/${escape(d.id)}/download" class="gen-doc-link" target="_blank">
                  ${d.kind === 'ntp_pdf' ? '\uD83D\uDCC4' : '\uD83D\uDCDD'} ${escape(d.original_filename)}
                  <span class="muted">(${formatSize(d.size_bytes)})</span>
                </a>
                <form method="post" action="/documents/${escape(d.id)}/delete" style="display:inline" onsubmit="return confirm('Delete this document?')">
                  <input type="hidden" name="return_to" value="/jobs/${escape(jobId)}/ntp">
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
          <h2 class="quote-banner-title">NOTICE TO PROCEED</h2>
          <p class="quote-banner-type">EPS</p>
        </div>
        <img src="/img/logo-black.png" alt="C-LARS" class="quote-banner-logo">
      </div>
    </section>
  `;

  // ── 3. Details card ───────────────────────────────────────────────
  const detailsSection = !docData
    ? html`
        <section class="card quote-doc-card quote-doc-last">
          <p class="muted">No accepted quote on the parent opportunity yet — NTP cannot be prepared.</p>
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
              </p>` : ''}
          </div>
        </div>
        <div class="quote-meta-right">
          ${canIssue ? html`
            <form method="post" action="/jobs/${escape(jobId)}/issue-ntp" id="ntp-issue-form">
              <table class="quote-meta-table">
                <tr>
                  <td class="meta-label">NTP No:</td>
                  <td><input type="text" name="ntp_number" value="${escape(defaultNtpNumber)}" class="meta-input" style="width:100%"></td>
                </tr>
                <tr>
                  <td class="meta-label">Date:</td>
                  <td><span class="muted">Stamped at issuance</span></td>
                </tr>
                <tr>
                  <td class="meta-label">References OC:</td>
                  <td><strong>${escape(job.oc_number || '\u2014')}</strong></td>
                </tr>
              </table>
              <p class="muted" style="margin:0.5rem 0 0;font-size:0.8em">Issuing the NTP marks the job as handed off.</p>
            </form>
          ` : html`
            <table class="quote-meta-table">
              <tr>
                <td class="meta-label">NTP No:</td>
                <td><strong>${escape(job.ntp_number || '\u2014')}</strong></td>
              </tr>
              <tr>
                <td class="meta-label">Date:</td>
                <td>${escape((job.ntp_issued_at || '').slice(0, 10) || '\u2014')}</td>
              </tr>
              <tr>
                <td class="meta-label">References OC:</td>
                <td><strong>${escape(job.oc_number || '\u2014')}</strong></td>
              </tr>
            </table>
          `}
        </div>
      </div>

      ${docData.quoteTitle ? html`
        <p style="margin:0.75rem 0 0"><strong>Project:</strong> ${escape(docData.quoteTitle)}</p>
      ` : ''}
    </section>
  `;

  // ── 4. Scope card (read-only summary of the OC's scope) ───────────
  const scopeSection = docData ? html`
    <section class="card quote-doc-card">
      <h2>Scope</h2>
      <p class="muted" style="margin:0 0 0.5rem;font-size:0.85em">
        Authorized scope of work, inherited from the accepted quote and confirmed in the OC.
      </p>
      ${docData.description ? html`
        <p style="white-space:pre-wrap;margin:0 0 0.75rem">${escape(docData.description)}</p>
      ` : ''}
      <table class="data compact quote-lines-table">
        <thead>
          <tr>
            <th class="col-num">#</th>
            <th class="col-item">Item</th>
            <th class="num col-qty">Qty</th>
            <th class="col-unit">Unit</th>
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
              </td>
              <td class="num col-qty">${escape(l.quantity || '')}</td>
              <td class="col-unit">${escape(l.unit || '')}</td>
              <td class="num col-ext">${escape(l.amount || '')}</td>
            </tr>
          `)}
          <tr>
            <td colspan="4" class="num"><strong>Total</strong></td>
            <td class="num"><strong>${escape(docData.quoteTotal || '')}</strong></td>
          </tr>
        </tbody>
      </table>
    </section>
  ` : '';

  // ── 5. Governance footer (T&Cs/Warranty/etc. snapshot) ────────────
  const footerSection = docData ? html`
    <section class="card quote-doc-card quote-doc-last">
      <strong>Governance</strong>
      <p class="muted" style="margin:0.25rem 0 0;font-size:0.85em">
        T&amp;Cs ${escape(docData.tcRevision || '\u2014')}
        · Warranty ${escape(docData.warrantyRevision || '\u2014')}
        · Rate Schedule ${escape(docData.rateScheduleRevision || '\u2014')}
        · SOP ${escape(docData.sopRevision || '\u2014')}
      </p>
      ${docData.deliveryTerms ? html`
        <div style="margin-top:0.75rem">
          <strong>Delivery terms</strong>
          <p style="white-space:pre-wrap;margin:0.25rem 0 0">${escape(docData.deliveryTerms)}</p>
        </div>` : ''}
    </section>
  ` : '';

  // ── Templates section ─────────────────────────────────────────────
  const templatesSection = html`
    <section class="card">
      <h2>Document Templates</h2>
      ${raw(templateManagerHtml('ntp'))}
    </section>
  `;

  const tabs = renderJobTabs(jobId, job.job_type, 'ntp');
  const body = tabs + headerSection + bannerCard + detailsSection + scopeSection + footerSection + templatesSection;

  return htmlResponse(
    layout(`NTP ${job.ntp_number || job.number}`, body, {
      user,
      env: data?.env,
      activeNav: '/jobs',
      flash: readFlash(url),
      breadcrumbs: [
        { label: 'Jobs', href: '/jobs' },
        { label: escape(job.number), href: `/jobs/${jobId}` },
        { label: 'NTP' },
      ],
    })
  );
}
