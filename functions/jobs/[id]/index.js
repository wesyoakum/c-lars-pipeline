// functions/jobs/[id]/index.js
//
// GET /jobs/:id — job detail page
//
// Inline-editable fields auto-save via fetch to /jobs/:id/patch.

import { all, one } from '../../lib/db.js';
import { layout, htmlResponse, html, raw, escape } from '../../lib/layout.js';
import { ICON_MIC } from '../../lib/icons.js';
import { redirectWithFlash, readFlash } from '../../lib/http.js';
import { parseTransactionTypes } from '../../lib/validators.js';
import { templateTypeForOC, templateManagerHtml } from '../../lib/template-catalog.js';
import { renderJobTabs } from '../../lib/job-tabs.js';

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

function statusClass(status) {
  if (status === 'handed_off') return 'pill-green';
  if (status === 'cancelled') return 'pill-red';
  if (status === 'awaiting_ntp') return 'pill-yellow';
  return '';
}

// ---- helpers for inline-editable fields ----------------------------------

function inlineText(field, value, opts = {}) {
  const display = value || opts.placeholder || '—';
  const displayClass = value ? '' : 'muted';
  return html`<span class="ie" data-field="${field}" data-type="text" ${opts.inputType ? `data-input-type="${opts.inputType}"` : ''}>
    <span class="ie-display ${displayClass}">${escape(display)}</span>
  </span>`;
}

function inlineTextarea(field, value, opts = {}) {
  const display = value || opts.placeholder || '—';
  const displayClass = value ? '' : 'muted';
  return html`<span class="ie" data-field="${field}" data-type="textarea">
    <span class="ie-display ${displayClass}">${escape(display)}</span>
    <span class="ie-raw" hidden>${escape(value ?? '')}</span>
  </span>`;
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
            -- Prefer the ACCEPTED quote for OC/NTP number defaults
            -- (that's the quote the customer actually signed off on).
            -- Fall back to the newest live quote if none are accepted yet
            -- so manually-created jobs still get a sensible suggestion.
            COALESCE(
              (SELECT q.number FROM quotes q
                WHERE q.opportunity_id = j.opportunity_id
                  AND q.status = 'accepted'
                ORDER BY q.created_at DESC LIMIT 1),
              (SELECT q.number FROM quotes q
                WHERE q.opportunity_id = j.opportunity_id
                  AND q.status NOT IN ('superseded','expired','rejected')
                ORDER BY q.created_at DESC LIMIT 1)
            ) AS latest_quote_number
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
  const canIssueOc = job.status === 'created';
  const canIssueNtp = isEps && job.status === 'awaiting_ntp';
  // Change orders are available on any active job. The user opens a CO
  // when scope changes mid-project; each CO runs its own quote cycle →
  // amended OC via /jobs/:id/change-orders/*.
  const canCreateCO = job.status !== 'cancelled' && job.status !== 'complete';
  const canClose = job.status !== 'handed_off' && job.status !== 'cancelled' && job.status !== 'complete';
  // `handed_off` is the gateway to `complete` — the new terminal
  // status introduced alongside the active-only rules (migration 0035).
  // Complete cascades accepted quotes on the parent opp to the hidden
  // `completed` status; see functions/jobs/[id]/complete.js.
  const canComplete = job.status === 'handed_off';
  const isActive = job.status !== 'cancelled' && job.status !== 'complete';
  const defaultOcNumber = job.latest_quote_number ? `OC-${job.latest_quote_number}` : '';
  const defaultNtpNumber = job.latest_quote_number ? `NTP-${job.latest_quote_number}` : '';

  // Load all change orders on this job so we can render a summary
  // table in the Change Orders section.
  const changeOrders = await all(
    env.DB,
    `SELECT id, number, sequence, status, description,
            amended_oc_number, amended_oc_issued_at,
            created_at, updated_at
       FROM change_orders
      WHERE job_id = ?
      ORDER BY sequence ASC`,
    [jobId]
  );

  const body = html`
    ${renderJobTabs(job.id, job.job_type, 'overview')}
    <section class="card" x-data="jobInline('${escape(job.id)}')">
      <div class="card-header">
        <h1 class="page-title">
          ${escape(job.number)}
          — ${inlineText('title', job.title, { placeholder: 'Add title' })}
        </h1>
        ${user && user.email === 'wes.yoakum@c-lars.com' ? html`<div class="header-actions" style="display:flex;gap:.4rem;flex-wrap:wrap;align-items:center">
          <button type="button" class="aii-page-capture-btn"
                  onclick="window.PipelineAICapture && window.PipelineAICapture.open({ refType: 'job', refId: '${escape(job.id)}', refLabel: '${escape(job.number)} — ${escape((job.title || '').slice(0, 60))}' })">
            <span class="aii-page-capture-icon">${raw(ICON_MIC)}</span> Capture
          </button>
        </div>` : ''}
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
            <span class="detail-label">NTP Number</span>
            <span class="detail-value">${escape(job.ntp_number || '—')}</span>
          </div>
          <div class="detail-pair">
            <span class="detail-label">NTP Issued</span>
            <span class="detail-value">${job.ntp_issued_at ? html`${escape(job.ntp_issued_at.slice(0, 10))} by ${escape(job.ntp_issued_by_name || '—')}` : '—'}</span>
          </div>` : ''}
        <div class="detail-pair">
          <span class="detail-label">External PM System</span>
          <span class="detail-value">${inlineText('external_pm_system', job.external_pm_system, { placeholder: 'Monday, Smartsheet...' })}</span>
        </div>
        <div class="detail-pair">
          <span class="detail-label">External Reference</span>
          <span class="detail-value">${inlineText('external_pm_system_ref', job.external_pm_system_ref, { placeholder: 'https://...' })}</span>
        </div>
        ${job.handed_off_at ? html`
          <div class="detail-pair">
            <span class="detail-label">Handed Off</span>
            <span class="detail-value">${escape(job.handed_off_at.slice(0, 10))} by ${escape(job.handed_off_by_name || '—')}</span>
          </div>` : ''}
        <div class="detail-pair" style="grid-column: 1/-1">
          <span class="detail-label">Notes</span>
          <span class="detail-value">${inlineTextarea('notes', job.notes, { placeholder: 'Add notes' })}</span>
        </div>
      </div>
    </section>

    <!-- Actions -->
    ${isActive ? html`
    <section class="card">
      <h2>Actions</h2>
      <div style="display:flex; flex-wrap:wrap; gap:0.75rem; align-items:start;">

        ${canIssueOc ? html`
          <fieldset class="action-form">
            <legend>Order Confirmation</legend>
            <p class="muted" style="margin:0 0 0.5rem;font-size:0.85em">
              Open the OC page to review the document layout, set the OC number and
              customer PO, and issue.
            </p>
            <a class="btn primary" href="/jobs/${escape(job.id)}/oc">Prepare OC \u2192</a>
          </fieldset>` : ''}

        ${!canIssueOc && job.oc_issued_at ? html`
          <fieldset class="action-form">
            <legend>Order Confirmation</legend>
            <p class="muted" style="margin:0 0 0.5rem;font-size:0.85em">OC ${escape(job.oc_number || '')} issued ${escape((job.oc_issued_at || '').slice(0, 10))}.</p>
            <a class="btn" href="/jobs/${escape(job.id)}/oc">View OC \u2192</a>
          </fieldset>` : ''}

        ${canIssueNtp ? html`
          <fieldset class="action-form">
            <legend>Notice to Proceed</legend>
            <p class="muted" style="margin:0 0 0.5rem;font-size:0.85em">
              Open the NTP page to review the document layout and issue the NTP. This
              will mark the job as handed off.
            </p>
            <a class="btn primary" href="/jobs/${escape(job.id)}/ntp">Prepare NTP \u2192</a>
          </fieldset>` : ''}

        ${!canIssueNtp && isEps && job.ntp_issued_at ? html`
          <fieldset class="action-form">
            <legend>Notice to Proceed</legend>
            <p class="muted" style="margin:0 0 0.5rem;font-size:0.85em">NTP ${escape(job.ntp_number || '')} issued ${escape((job.ntp_issued_at || '').slice(0, 10))}.</p>
            <a class="btn" href="/jobs/${escape(job.id)}/ntp">View NTP \u2192</a>
          </fieldset>` : ''}

        ${canCreateCO ? html`
          <form method="post" action="/jobs/${escape(job.id)}/change-orders" class="action-form">
            <fieldset>
              <legend>Create Change Order</legend>
              <p class="muted" style="margin:0 0 0.5rem;font-size:0.85em">
                Scope changed? Create a change order and run it through its own
                quote + amended-OC cycle. The job stays in progress during the CO.
              </p>
              <div><label class="field-label">Description</label><input type="text" name="description" placeholder="Short scope-change summary"></div>
              <button class="btn primary" type="submit" style="margin-top:0.5rem">Create Change Order</button>
            </fieldset>
          </form>` : ''}

        ${canComplete ? html`
          <form method="post" action="/jobs/${escape(job.id)}/complete"
                onsubmit="return (confirm('Mark this job complete? Any accepted quotes on the opportunity will be marked as completed too.') ? (window.Pipeline.submitFormWithBlockerCheck(this, 'Mark this job complete'), false) : false);"
                class="action-form">
            <fieldset>
              <legend>Mark Complete</legend>
              <p class="muted" style="margin:0 0 0.5rem;font-size:0.85em">
                The job was handed off to the external PM system. When the work is done
                and accepted, mark it complete to close out the pipeline record.
              </p>
              <button class="btn primary" type="submit" style="margin-top:0.25rem">Mark Complete</button>
            </fieldset>
          </form>` : ''}

        ${canClose ? html`
          <form method="post" action="/jobs/${escape(job.id)}/close"
                onsubmit="return (confirm('Close this job?') ? (window.Pipeline.submitFormWithBlockerCheck(this, 'Cancel this job'), false) : false);"
                class="action-form">
            <fieldset>
              <legend>Close Job</legend>
              <div><label class="field-label">Reason</label><input type="text" name="reason" placeholder="Reason for closing"></div>
              <button class="btn danger" type="submit" style="margin-top:0.5rem">Close Job</button>
            </fieldset>
          </form>` : ''}

      </div>
    </section>` : ''}

    <!-- Change Orders -->
    <section class="card">
      <h2>Change Orders</h2>
      ${changeOrders.length === 0
        ? html`<p class="muted">No change orders on this job yet.</p>`
        : html`
          <table class="list">
            <thead>
              <tr>
                <th>#</th><th>Number</th><th>Status</th><th>Description</th>
                <th>Amended OC</th><th>Updated</th>
              </tr>
            </thead>
            <tbody>
              ${changeOrders.map(co => html`
                <tr>
                  <td>${escape(String(co.sequence))}</td>
                  <td><a href="/jobs/${escape(job.id)}/change-orders/${escape(co.id)}">${escape(co.number)}</a></td>
                  <td><span class="pill">${escape(co.status)}</span></td>
                  <td>${escape(co.description || '—')}</td>
                  <td>${escape(co.amended_oc_number || '—')}</td>
                  <td class="muted">${escape((co.updated_at || co.created_at || '').slice(0, 10))}</td>
                </tr>`)}
            </tbody>
          </table>`}
    </section>

    <!-- Document Templates -->
    <section class="card">
      <h2>Document Templates</h2>
      ${raw(templateManagerHtml(templateTypeForOC(jobTypes[0])))}
      ${isEps ? raw(templateManagerHtml('ntp')) : ''}
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
                ${e.override_reason ? html`<div><small class="muted">Reason: ${escape(e.override_reason)}</small></div>` : ''}
              </li>`;
            })}
          </ul>`}
    </section>`;

  const captureScripts = (user && user.email === 'wes.yoakum@c-lars.com')
    ? html`<script defer src="/js/audio-recorder.js"></script><script defer src="/js/ai-capture.js"></script>`
    : '';
  const scripts = html`<script>${raw(jobInlineScript())}</script>${captureScripts}`;

  return htmlResponse(
    layout(job.number, body + scripts, {
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

// ---- Inline-edit Alpine.js component ------------------------------------

function jobInlineScript() {
  return `
function jobInline(jobId) {
  const patchUrl = '/jobs/' + jobId + '/patch';
  return {
    saving: false,
    init() {
      this.$el.querySelectorAll('.ie').forEach(el => {
        el.addEventListener('click', () => this.activate(el));
      });
    },
    activate(el) {
      if (el.querySelector('.ie-input')) return;
      const field = el.dataset.field;
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
          if (e.key === 'Escape') { this.deactivate(el, input); }
        });
      } else {
        input = document.createElement('input');
        input.type = el.dataset.inputType || 'text';
        input.className = 'ie-input';
        input.value = currentValue;
        input.addEventListener('blur', () => this.save(el, input));
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); this.save(el, input); }
          if (e.key === 'Escape') { this.deactivate(el, input); }
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
        // Update display
        const display = el.querySelector('.ie-display');
        const rawEl = el.querySelector('.ie-raw');
        display.textContent = data.value || '—';
        display.classList.toggle('muted', !data.value);
        if (rawEl) rawEl.textContent = data.value ?? '';

        el.classList.add('ie-saved');
        setTimeout(() => el.classList.remove('ie-saved'), 1200);
      } catch (err) {
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
