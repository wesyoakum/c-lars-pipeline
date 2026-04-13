// functions/jobs/[id]/index.js
//
// GET  /jobs/:id   — job detail page
// POST /jobs/:id   — update job fields (notes, external PM, etc.)

import { all, one, stmt, batch } from '../../lib/db.js';
import { auditStmt, diff } from '../../lib/audit.js';
import { now } from '../../lib/ids.js';
import { layout, htmlResponse, html, raw, escape } from '../../lib/layout.js';
import { redirectWithFlash, formBody, readFlash } from '../../lib/http.js';
import { parseTransactionTypes } from '../../lib/validators.js';

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

function statusClass(status) {
  if (status === 'handed_off') return 'pill-green';
  if (status === 'cancelled') return 'pill-red';
  if (status === 'awaiting_authorization' || status === 'awaiting_ntp') return 'pill-yellow';
  return '';
}

export async function onRequestGet(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const jobId = params.id;

  const job = await one(
    env.DB,
    `SELECT j.*,
            o.number AS opp_number, o.title AS opp_title, o.id AS opp_id,
            o.transaction_type, o.customer_po_number AS opp_po_number,
            a.name AS account_name, a.id AS account_id,
            oc_user.display_name AS oc_issued_by_name,
            ntp_user.display_name AS ntp_issued_by_name,
            ho_user.display_name AS handed_off_by_name,
            creator.display_name AS created_by_name,
            (SELECT q.number FROM quotes q
              WHERE q.opportunity_id = j.opportunity_id
                AND q.status NOT IN ('superseded','expired','rejected')
              ORDER BY q.created_at DESC LIMIT 1) AS latest_quote_number
       FROM jobs j
       LEFT JOIN opportunities o ON o.id = j.opportunity_id
       LEFT JOIN accounts a ON a.id = o.account_id
       LEFT JOIN users oc_user ON oc_user.id = j.oc_issued_by_user_id
       LEFT JOIN users ntp_user ON ntp_user.id = j.ntp_issued_by_user_id
       LEFT JOIN users ho_user ON ho_user.id = j.handed_off_by_user_id
       LEFT JOIN users creator ON creator.id = j.created_by_user_id
      WHERE j.id = ?`,
    [jobId]
  );
  if (!job) {
    return redirectWithFlash('/jobs', 'Job not found.', 'error');
  }

  const events = await all(
    env.DB,
    `SELECT ae.event_type, ae.at, ae.summary, ae.changes_json,
            ae.override_reason,
            u.email AS user_email, u.display_name AS user_name
       FROM audit_events ae
       LEFT JOIN users u ON u.id = ae.user_id
      WHERE ae.entity_type = 'job' AND ae.entity_id = ?
      ORDER BY ae.at DESC LIMIT 100`,
    [jobId]
  );

  const jobTypes = parseTransactionTypes(job.job_type);
  const isEps = jobTypes.includes('eps');
  const isRefurb = jobTypes.includes('refurb');
  const canIssueOc = job.status === 'created';
  const canRecordAuth = isEps && job.status === 'awaiting_authorization';
  const canIssueNtp = isEps && job.status === 'awaiting_ntp';
  const canAmendOc = isRefurb && job.status === 'handed_off';
  const canClose = job.status !== 'handed_off' && job.status !== 'cancelled';
  const isActive = job.status !== 'handed_off' && job.status !== 'cancelled';
  const defaultOcNumber = job.latest_quote_number ? `OC-${job.latest_quote_number}` : '';
  const defaultNtpNumber = job.latest_quote_number ? `NTP-${job.latest_quote_number}` : '';

  const body = html`
    <section class="card">
      <div class="card-header">
        <h1 class="page-title">
          ${escape(job.number)}
          ${job.title ? html` — ${escape(job.title)}` : ''}
        </h1>
      </div>
      <p class="muted" style="margin:0.15rem 0 0.5rem">
        <span class="pill ${statusClass(job.status)}">${escape(STATUS_LABELS[job.status] ?? job.status)}</span>
        · ${escape(jobTypes.map(t => TYPE_LABELS[t] ?? t).join(', '))}
        · <a href="/opportunities/${escape(job.opp_id)}">${escape(job.opp_number)} — ${escape(job.opp_title)}</a>
        · <a href="/accounts/${escape(job.account_id)}">${escape(job.account_name)}</a>
      </p>

      <div class="detail-grid">
        <div class="detail-pair">
          <span class="detail-label">Customer PO</span>
          <span class="detail-value">${escape(job.customer_po_number || job.opp_po_number || '—')}</span>
        </div>
        <div class="detail-pair">
          <span class="detail-label">OC Number</span>
          <span class="detail-value">${escape(job.oc_number || '—')}</span>
        </div>
        <div class="detail-pair">
          <span class="detail-label">OC Revision</span>
          <span class="detail-value">${job.oc_issued_at ? escape(String(job.oc_revision)) : '—'}</span>
        </div>
        <div class="detail-pair">
          <span class="detail-label">OC Issued</span>
          <span class="detail-value">${job.oc_issued_at ? html`${escape(job.oc_issued_at.slice(0, 10))} by ${escape(job.oc_issued_by_name || '—')}` : '—'}</span>
        </div>
        ${isEps ? html`
          <div class="detail-pair">
            <span class="detail-label">Authorization</span>
            <span class="detail-value">${job.authorization_received_at ? escape(job.authorization_received_at.slice(0, 10)) : '—'}</span>
          </div>
          <div class="detail-pair">
            <span class="detail-label">NTP Number</span>
            <span class="detail-value">${escape(job.ntp_number || '—')}</span>
          </div>
          <div class="detail-pair">
            <span class="detail-label">NTP Issued</span>
            <span class="detail-value">${job.ntp_issued_at ? html`${escape(job.ntp_issued_at.slice(0, 10))} by ${escape(job.ntp_issued_by_name || '—')}` : '—'}</span>
          </div>` : ''}
        ${(job.ceo_concurrence_at || job.cfo_concurrence_at) ? html`
          <div class="detail-pair">
            <span class="detail-label">CEO Concurrence</span>
            <span class="detail-value">${job.ceo_concurrence_at ? html`${escape(job.ceo_concurrence_at.slice(0, 10))} — ${escape(job.ceo_concurrence_by || '—')}` : '—'}</span>
          </div>
          <div class="detail-pair">
            <span class="detail-label">CFO Concurrence</span>
            <span class="detail-value">${job.cfo_concurrence_at ? html`${escape(job.cfo_concurrence_at.slice(0, 10))} — ${escape(job.cfo_concurrence_by || '—')}` : '—'}</span>
          </div>` : ''}
        <div class="detail-pair">
          <span class="detail-label">External PM System</span>
          <span class="detail-value">${escape(job.external_pm_system || '—')}</span>
        </div>
        <div class="detail-pair">
          <span class="detail-label">External Reference</span>
          <span class="detail-value">${job.external_pm_system_ref
            ? (job.external_pm_system_ref.startsWith('http')
              ? html`<a href="${escape(job.external_pm_system_ref)}" target="_blank">${escape(job.external_pm_system_ref)}</a>`
              : escape(job.external_pm_system_ref))
            : '—'}</span>
        </div>
        ${job.handed_off_at ? html`
          <div class="detail-pair">
            <span class="detail-label">Handed Off</span>
            <span class="detail-value">${escape(job.handed_off_at.slice(0, 10))} by ${escape(job.handed_off_by_name || '—')}</span>
          </div>` : ''}
        <div class="detail-pair" style="grid-column: 1/-1">
          <span class="detail-label">Notes</span>
          <span class="detail-value">${escape(job.notes || '—')}</span>
        </div>
      </div>
    </section>

    <!-- Actions -->
    ${isActive ? html`
    <section class="card">
      <h2>Actions</h2>
      <div style="display:flex; flex-wrap:wrap; gap:0.75rem; align-items:start;">

        ${canIssueOc ? html`
          <form method="post" action="/jobs/${escape(job.id)}/issue-oc" class="action-form">
            <fieldset>
              <legend>Issue Order Confirmation</legend>
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.5rem;">
                <div><label class="field-label">OC Number *</label><input type="text" name="oc_number" value="${escape(defaultOcNumber)}" required></div>
                <div><label class="field-label">Customer PO #</label><input type="text" name="customer_po_number" value="${escape(job.customer_po_number || job.opp_po_number || '')}"></div>
              </div>
              <button class="btn primary" type="submit" style="margin-top:0.5rem">Issue OC</button>
            </fieldset>
          </form>` : ''}

        ${canRecordAuth ? html`
          <form method="post" action="/jobs/${escape(job.id)}/record-authorization" class="action-form">
            <fieldset>
              <legend>Record Customer Authorization</legend>
              <div><label class="field-label">Notes</label><input type="text" name="authorization_notes" placeholder="Optional notes"></div>
              <div style="margin-top:0.4rem; display:grid; grid-template-columns:1fr 1fr; gap:0.5rem;">
                <div><label class="field-label">CEO Concurrence</label><input type="text" name="ceo_concurrence_by" placeholder="Name (optional)"></div>
                <div><label class="field-label">CFO Concurrence</label><input type="text" name="cfo_concurrence_by" placeholder="Name (optional)"></div>
              </div>
              <button class="btn primary" type="submit" style="margin-top:0.5rem">Record Authorization</button>
            </fieldset>
          </form>` : ''}

        ${canIssueNtp ? html`
          <form method="post" action="/jobs/${escape(job.id)}/issue-ntp" class="action-form">
            <fieldset>
              <legend>Issue Notice to Proceed</legend>
              <div><label class="field-label">NTP Number</label><input type="text" name="ntp_number" value="${escape(defaultNtpNumber)}"></div>
              <p class="muted" style="margin:0.4rem 0; font-size:0.85em">This will mark the job as handed off.</p>
              <button class="btn primary" type="submit" style="margin-top:0.5rem">Issue NTP</button>
            </fieldset>
          </form>` : ''}

        ${canAmendOc ? html`
          <form method="post" action="/jobs/${escape(job.id)}/amend-oc" class="action-form">
            <fieldset>
              <legend>Amend OC (Rev ${escape(String(job.oc_revision + 1))})</legend>
              <div><label class="field-label">New OC Number</label><input type="text" name="oc_number" value="${escape(job.oc_number || '')}" required></div>
              <div><label class="field-label">Notes</label><input type="text" name="notes" placeholder="Reason for amendment"></div>
              <button class="btn primary" type="submit" style="margin-top:0.5rem">Amend OC</button>
            </fieldset>
          </form>` : ''}

        <!-- Edit general fields -->
        <form method="post" action="/jobs/${escape(job.id)}" class="action-form">
          <fieldset>
            <legend>Edit Details</legend>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.5rem;">
              <div><label class="field-label">Title</label><input type="text" name="title" value="${escape(job.title || '')}"></div>
              <div><label class="field-label">External PM System</label><input type="text" name="external_pm_system" value="${escape(job.external_pm_system || '')}" placeholder="Monday, Smartsheet..."></div>
              <div style="grid-column:1/-1"><label class="field-label">External Reference (URL or ID)</label><input type="text" name="external_pm_system_ref" value="${escape(job.external_pm_system_ref || '')}" placeholder="https://..."></div>
              <div style="grid-column:1/-1"><label class="field-label">Notes</label><textarea name="notes" rows="2" style="width:100%">${escape(job.notes || '')}</textarea></div>
            </div>
            <button class="btn primary" type="submit" style="margin-top:0.5rem">Save</button>
          </fieldset>
        </form>

        ${canClose ? html`
          <form method="post" action="/jobs/${escape(job.id)}/close"
                onsubmit="return confirm('Close this job?')" class="action-form">
            <fieldset>
              <legend>Close Job</legend>
              <div><label class="field-label">Reason</label><input type="text" name="reason" placeholder="Reason for closing"></div>
              <button class="btn danger" type="submit" style="margin-top:0.5rem">Close Job</button>
            </fieldset>
          </form>` : ''}

      </div>
    </section>` : ''}

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
                ${e.override_reason ? html`<div><small class="muted">Reason: ${escape(e.override_reason)}</small></div>` : ''}
              </li>`;
            })}
          </ul>`}
    </section>`;

  return htmlResponse(
    layout(job.number, body, {
      user,
      env: data?.env,
      activeNav: '/jobs',
      flash: readFlash(url),
      breadcrumbs: [
        { label: 'Jobs', href: '/jobs' },
        { label: escape(job.number) },
      ],
    })
  );
}

// POST /jobs/:id — update general fields
const UPDATE_FIELDS = ['title', 'notes', 'external_pm_system', 'external_pm_system_ref'];

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const jobId = params.id;

  const before = await one(env.DB, 'SELECT * FROM jobs WHERE id = ?', [jobId]);
  if (!before) return redirectWithFlash('/jobs', 'Job not found.', 'error');

  const input = await formBody(request);
  const ts = now();

  const after = {};
  for (const f of UPDATE_FIELDS) {
    after[f] = (typeof input[f] === 'string' ? input[f].trim() : input[f]) || null;
  }

  const changes = diff(before, after, UPDATE_FIELDS);
  if (changes) {
    await batch(env.DB, [
      stmt(env.DB,
        `UPDATE jobs SET title = ?, notes = ?, external_pm_system = ?,
                external_pm_system_ref = ?, updated_at = ?
            WHERE id = ?`,
        [after.title, after.notes, after.external_pm_system,
         after.external_pm_system_ref, ts, jobId]),
      auditStmt(env.DB, {
        entityType: 'job',
        entityId: jobId,
        eventType: 'updated',
        user,
        summary: `Updated job ${before.number}`,
        changes,
      }),
    ]);
  }

  return redirectWithFlash(`/jobs/${jobId}`, 'Saved.');
}
