// functions/opportunities/[id]/index.js
//
// GET  /opportunities/:id           — detail (Overview tab by default)
// POST /opportunities/:id           — update from the edit form
//
// Overview uses inline-editable fields that auto-save via fetch to
// /opportunities/:id/patch.

import { one, all, stmt, batch } from '../../lib/db.js';
import { auditStmt, diff } from '../../lib/audit.js';
import { validateOpportunity } from '../../lib/validators.js';
import { layout, htmlResponse, html, escape, raw } from '../../lib/layout.js';
import { now } from '../../lib/ids.js';
import { redirectWithFlash, formBody, readFlash } from '../../lib/http.js';
import { loadStageCatalog } from '../../lib/stages.js';
import {
  loadPricingSettings,
  loadCostBuildBundle,
  computeFromBundle,
  fmtDollar,
  fmtPct,
} from '../../lib/pricing.js';
import {
  QUOTE_TYPE_LABELS,
  QUOTE_STATUS_LABELS,
  allowedQuoteTypes,
  parseTransactionTypes,
} from '../../lib/validators.js';

const UPDATE_FIELDS = [
  'number', 'title', 'account_id', 'primary_contact_id', 'description',
  'transaction_type', 'rfq_format', 'source',
  'estimated_value_usd', 'probability',
  'expected_close_date', 'rfq_received_date', 'rfq_due_date',
  'rfi_due_date', 'quoted_date',
  'bant_budget', 'bant_authority', 'bant_authority_contact_id',
  'bant_need', 'bant_timeline',
  'owner_user_id', 'salesperson_user_id', 'customer_po_number',
];

const TYPE_LABELS = {
  spares: 'Spares', eps: 'Engineered Product (EPS)',
  refurb: 'Refurbishment', service: 'Service',
};

const TYPE_OPTIONS = [
  { value: 'spares', label: 'Spares' },
  { value: 'eps', label: 'Engineered Product (EPS)' },
  { value: 'refurb', label: 'Refurbishment' },
  { value: 'service', label: 'Service' },
];

const RFQ_FORMAT_LABELS = {
  verbal: 'Verbal', text: 'Text',
  email_informal: 'Email — informal', email_formal: 'Email — formal',
  formal_document: 'Formal RFQ', government_rfq: 'Government RFQ',
  rfi_preliminary: 'RFI / preliminary', none: 'Proactive outreach', other: 'Other',
};
const RFQ_FORMAT_OPTIONS = [
  { value: '', label: '— Not specified —' },
  { value: 'verbal', label: 'Verbal' },
  { value: 'text', label: 'Text message' },
  { value: 'email_informal', label: 'Email — informal' },
  { value: 'email_formal', label: 'Email — formal' },
  { value: 'formal_document', label: 'Formal RFQ' },
  { value: 'government_rfq', label: 'Government RFQ' },
  { value: 'rfi_preliminary', label: 'RFI / preliminary' },
  { value: 'none', label: 'Proactive outreach' },
  { value: 'other', label: 'Other' },
];

const SOURCE_LABELS = {
  inbound: 'Inbound', outreach: 'Outreach',
  referral: 'Referral', existing: 'Existing customer', other: 'Other',
};
const SOURCE_OPTIONS = [
  { value: '', label: '— Not specified —' },
  { value: 'inbound', label: 'Inbound' },
  { value: 'outreach', label: 'Outreach' },
  { value: 'referral', label: 'Referral' },
  { value: 'existing', label: 'Existing customer' },
  { value: 'other', label: 'Other' },
];

const BANT_BUDGET_OPTIONS = [
  { value: '', label: '— Unknown —' },
  { value: 'known', label: 'Known' },
  { value: 'estimated', label: 'Estimated' },
  { value: 'unknown', label: 'Unknown' },
];

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

function inlineDate(field, value) {
  const display = value || '—';
  const displayClass = value ? '' : 'muted';
  return html`<span class="ie" data-field="${field}" data-type="date">
    <span class="ie-display ${displayClass}">${escape(display)}</span>
  </span>`;
}

function inlineSelect(field, value, options) {
  const selectedOpt = options.find(o => o.value === (value ?? ''));
  const display = selectedOpt?.label || value || '—';
  const displayClass = value ? '' : 'muted';
  const optJson = JSON.stringify(options);
  return html`<span class="ie" data-field="${field}" data-type="select" data-options='${escape(optJson)}'>
    <span class="ie-display ${displayClass}">${escape(display)}</span>
  </span>`;
}

function inlineMoney(field, value) {
  const display = value != null ? `$${formatMoney(value)}` : '—';
  const displayClass = value != null ? '' : 'muted';
  return html`<span class="ie" data-field="${field}" data-type="text" data-input-type="number">
    <span class="ie-display ${displayClass}">${escape(display)}</span>
    <span class="ie-raw" hidden>${value ?? ''}</span>
  </span>`;
}

// ---- GET handler ---------------------------------------------------------

export async function onRequestGet(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const oppId = params.id;
  const tab = url.searchParams.get('tab') || 'overview';

  const opp = await one(
    env.DB,
    `SELECT o.*, a.name AS account_name,
            c.first_name AS contact_first, c.last_name AS contact_last,
            c.email AS contact_email, c.phone AS contact_phone,
            auth.first_name AS auth_first, auth.last_name AS auth_last,
            auth.email AS auth_email, auth.title AS auth_title,
            ou.display_name AS owner_name, ou.email AS owner_email,
            sp.display_name AS sp_name, sp.email AS sp_email
       FROM opportunities o
       LEFT JOIN accounts  a    ON a.id    = o.account_id
       LEFT JOIN contacts  c    ON c.id    = o.primary_contact_id
       LEFT JOIN contacts  auth ON auth.id = o.bant_authority_contact_id
       LEFT JOIN users     ou   ON ou.id   = o.owner_user_id
       LEFT JOIN users     sp   ON sp.id   = o.salesperson_user_id
      WHERE o.id = ?`,
    [oppId]
  );
  if (!opp) return notFound(context);

  const catalog = await loadStageCatalog(env.DB);
  const primaryType = parseTransactionTypes(opp.transaction_type)[0] ?? 'spares';
  const typeStages = catalog.get(primaryType) ?? [];
  const currentIdx = typeStages.findIndex(s => s.stage_key === opp.stage);
  const currentStage = typeStages[currentIdx] ?? null;

  // Account contacts for primary-contact dropdown + contact strip.
  const contacts = await all(
    env.DB,
    `SELECT id, first_name, last_name, title, email, phone, is_primary
       FROM contacts WHERE account_id = ? ORDER BY is_primary DESC, last_name, first_name`,
    [opp.account_id]
  );

  // Users for owner/salesperson selects
  const users = await all(
    env.DB,
    `SELECT id, display_name, email FROM users WHERE active = 1 ORDER BY display_name`
  );

  // Accounts for account select
  const accounts = await all(env.DB, 'SELECT id, name FROM accounts ORDER BY name');

  // Price builds
  let priceBuildRows = [];
  let priceBuildBadgeCount = 0;
  {
    const rows = await all(
      env.DB,
      `SELECT cb.id, cb.label, cb.status, cb.updated_at, cb.quote_line_id,
              ql.description AS line_description,
              q.number AS quote_number, q.revision AS quote_revision, q.id AS quote_id
         FROM cost_builds cb
         JOIN quote_lines ql ON ql.id = cb.quote_line_id
         JOIN quotes q ON q.id = ql.quote_id
        WHERE q.opportunity_id = ?
        ORDER BY q.created_at DESC, ql.sort_order`,
      [oppId]
    );
    priceBuildBadgeCount = rows.length;
    if (tab === 'cost') {
      const settings = await loadPricingSettings(env.DB);
      for (const cb of rows) {
        const bundle = await loadCostBuildBundle(env.DB, cb.id);
        const result = computeFromBundle(bundle, settings);
        priceBuildRows.push({ row: cb, result });
      }
    }
  }

  // Quotes
  let quoteRows = [];
  let quoteBadgeCount = 0;
  {
    const rows = await all(
      env.DB,
      `SELECT id, number, revision, quote_type, status, title, total_price,
              valid_until, submitted_at, updated_at, supersedes_quote_id
         FROM quotes WHERE opportunity_id = ? ORDER BY created_at DESC`,
      [oppId]
    );
    quoteBadgeCount = rows.length;
    if (tab === 'quotes') quoteRows = rows;
  }

  // Tasks
  let taskRows = [];
  let taskBadgeCount = 0;
  {
    const rows = await all(
      env.DB,
      `SELECT a.id, a.type, a.subject, a.body, a.status, a.due_at,
              a.completed_at, a.direction, a.created_at,
              u.display_name AS assigned_name, u.email AS assigned_email,
              cu.display_name AS created_by_name, cu.email AS created_by_email
         FROM activities a
         LEFT JOIN users u ON u.id = a.assigned_user_id
         LEFT JOIN users cu ON cu.id = a.created_by_user_id
        WHERE a.opportunity_id = ?
        ORDER BY
          CASE WHEN a.status = 'pending' THEN 0 ELSE 1 END,
          CASE WHEN a.due_at IS NOT NULL THEN 0 ELSE 1 END,
          a.due_at ASC, a.created_at DESC
        LIMIT 100`,
      [oppId]
    );
    taskBadgeCount = rows.filter(r => r.status === 'pending').length;
    taskRows = rows;
  }

  // Documents
  let docRows = [];
  let docBadgeCount = 0;
  {
    const rows = await all(
      env.DB,
      `SELECT d.id, d.kind, d.title, d.original_filename, d.mime_type,
              d.size_bytes, d.notes, d.uploaded_at,
              u.display_name AS uploaded_by_name, u.email AS uploaded_by_email
         FROM documents d
         LEFT JOIN users u ON u.id = d.uploaded_by_user_id
        WHERE d.opportunity_id = ?
        ORDER BY d.uploaded_at DESC`,
      [oppId]
    );
    docBadgeCount = rows.length;
    docRows = rows;
  }

  // Audit events — include opportunity events plus related entity events
  // (documents, quotes, activities, cost builds tied to this opp)
  const events = await all(
    env.DB,
    `SELECT ae.event_type, ae.entity_type, ae.at, ae.summary,
            ae.changes_json, ae.override_reason,
            u.email AS user_email, u.display_name AS user_name
       FROM audit_events ae
       LEFT JOIN users u ON u.id = ae.user_id
      WHERE (ae.entity_type = 'opportunity' AND ae.entity_id = ?)
         OR (ae.entity_type = 'document' AND ae.entity_id IN
             (SELECT id FROM documents WHERE opportunity_id = ?))
         OR (ae.entity_type = 'quote' AND ae.entity_id IN
             (SELECT id FROM quotes WHERE opportunity_id = ?))
         OR (ae.entity_type = 'activity' AND ae.entity_id IN
             (SELECT id FROM activities WHERE opportunity_id = ?))
      ORDER BY ae.at DESC LIMIT 200`,
    [oppId, oppId, oppId, oppId]
  );

  const primaryContactName = [opp.contact_first, opp.contact_last].filter(Boolean).join(' ');
  const authorityName = [opp.auth_first, opp.auth_last].filter(Boolean).join(' ');
  const ownerLabel = opp.owner_name ?? opp.owner_email ?? '—';
  const salespersonLabel = opp.sp_name ?? opp.sp_email ?? '—';

  // ---- Stage carousel data -----------------------------------------------
  // All stages go in the carousel, including loss stages.
  const carouselStages = typeStages;
  const carouselIdx = carouselStages.findIndex(s => s.stage_key === opp.stage);
  const effectiveIdx = carouselIdx >= 0 ? carouselIdx : 0;

  // Build option lists for inline-edit select fields
  const contactOptions = [
    { value: '', label: '— None —' },
    ...contacts.map(c => ({
      value: c.id,
      label: [c.first_name, c.last_name].filter(Boolean).join(' ') || '(no name)',
    })),
    { value: '__new__', label: '+ Add new contact...' },
  ];
  const userOptions = [
    { value: '', label: '— None —' },
    ...users.map(u => ({ value: u.id, label: u.display_name ?? u.email })),
  ];
  const accountOptions = [
    { value: '', label: '— Select —' },
    ...accounts.map(a => ({ value: a.id, label: a.name })),
  ];

  // ---- Overview tab ------------------------------------------------------
  const overviewTab = html`
    <section class="card" x-data="oppInline('${escape(opp.id)}', '${escape(opp.account_id)}')">
      <div class="card-header">
        <div>
          <h1 class="page-title">
            ${inlineText('title', opp.title)}
            <span class="header-value">${inlineMoney('estimated_value_usd', opp.estimated_value_usd)}</span>
          </h1>
          <p class="muted" style="margin:0.15rem 0 0">
            <code>${escape(opp.number)}</code>
            · <a href="/accounts/${escape(opp.account_id)}">${escape(opp.account_name ?? '—')}</a>
            · <span x-data="oppTypePicker('${escape(opp.transaction_type ?? '')}', '${escape(opp.id)}')" class="type-pills-inline">
                <template x-for="t in allTypes" :key="t.value">
                  <button type="button" class="pill pill-toggle"
                          :class="{ 'pill-active': selected.indexOf(t.value) !== -1 }"
                          @click="toggle(t.value)"
                          x-text="t.label"></button>
                </template>
              </span>
          </p>
        </div>
        <a class="icon-btn primary" href="/opportunities/${escape(opp.id)}?tab=quotes" title="New quote">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="10" y1="4" x2="10" y2="16"/><line x1="4" y1="10" x2="16" y2="10"/></svg>
        </a>
      </div>

      <!-- Stage carousel -->
      <form method="post" action="/opportunities/${escape(opp.id)}/stage"
            x-data="stageCarousel(${effectiveIdx}, ${carouselStages.length})"
            x-ref="stageForm"
            class="stage-carousel" style="margin:0.5rem 0">
        <input type="hidden" name="to_stage" x-ref="toStage" value="">
        <div class="stage-carousel-row">
          <button type="button" class="stage-arrow" @click="prev()" :disabled="idx <= 0">&lsaquo;</button>
          <div class="stage-carousel-window">
            ${carouselStages.map((s, i) => {
              const isCurrent = s.stage_key === opp.stage;
              const isLoss = s.stage_key === 'closed_lost' || s.stage_key === 'closed_died';
              let cls = 'stage-pill';
              if (isCurrent) cls += ' stage-pill-current';
              else if (isLoss) cls += ' stage-pill-loss';
              else if (s.sort_order < (currentStage?.sort_order ?? 0)) cls += ' stage-pill-past';
              return html`
                <button type="button"
                        class="${cls}" data-idx="${i}"
                        x-show="Math.abs(${i} - idx) <= 1"
                        ${isCurrent ? 'disabled' : ''}
                        @click="${isLoss && !isCurrent
                          ? `showCloseReason('${s.stage_key}')`
                          : `$refs.toStage.value='${s.stage_key}'; $refs.stageForm.submit()`}">
                  ${s.label}
                </button>`;
            })}
          </div>
          <button type="button" class="stage-arrow" @click="next()" :disabled="idx >= max - 1">&rsaquo;</button>
        </div>

        <!-- Close reason (shown when clicking a loss stage) -->
        <template x-if="closingStage">
          <div class="stage-close-reason">
            <input type="text" name="override_reason" x-ref="closeReasonInput"
                   placeholder="Close reason (required)" required
                   style="font-size:0.85em; flex:1; min-width:200px; max-width:400px;">
            <button type="button" class="btn btn-sm danger"
                    @click="$refs.toStage.value = closingStage; $refs.stageForm.submit()">Confirm</button>
            <button type="button" class="btn btn-sm" @click="closingStage = ''">Cancel</button>
          </div>
        </template>
      </form>

      <!-- Main detail fields -->
      <div x-data="{ more: false }" >
        <div class="detail-grid">
          <div class="detail-pair">
            <span class="detail-label">Account</span>
            <span class="detail-value">${inlineSelect('account_id', opp.account_id, accountOptions)}</span>
          </div>
          <div class="detail-pair">
            <span class="detail-label">Primary contact</span>
            <span class="detail-value">${inlineSelect('primary_contact_id', opp.primary_contact_id, contactOptions)}</span>
          </div>
          <div class="detail-pair">
            <span class="detail-label">Owner</span>
            <span class="detail-value">${inlineSelect('owner_user_id', opp.owner_user_id, userOptions)}</span>
          </div>
          <div class="detail-pair">
            <span class="detail-label">RFQ received</span>
            <span class="detail-value">${inlineDate('rfq_received_date', opp.rfq_received_date)}</span>
          </div>
          <div class="detail-pair">
            <span class="detail-label">RFQ due</span>
            <span class="detail-value">${inlineDate('rfq_due_date', opp.rfq_due_date)}</span>
          </div>
          ${opp.customer_po_number ? html`
          <div class="detail-pair">
            <span class="detail-label">Customer PO</span>
            <span class="detail-value">${inlineText('customer_po_number', opp.customer_po_number, { placeholder: '—' })}</span>
          </div>` : ''}
          ${opp.quoted_date ? html`
          <div class="detail-pair">
            <span class="detail-label">Quoted</span>
            <span class="detail-value">${inlineDate('quoted_date', opp.quoted_date)}</span>
          </div>` : ''}
          ${opp.expected_close_date ? html`
          <div class="detail-pair">
            <span class="detail-label">Expected close</span>
            <span class="detail-value">${inlineDate('expected_close_date', opp.expected_close_date)}</span>
          </div>` : ''}
          <div class="detail-pair">
            <span class="detail-label">Created</span>
            <span class="detail-value muted">${escape((opp.created_at ?? '').slice(0, 10) || '—')}</span>
          </div>
        </div>

        <!-- Description -->
        <div style="margin-top:0.5rem">
          <span class="detail-label" style="display:block; margin-bottom:0.15rem">Description</span>
          ${inlineTextarea('description', opp.description ?? '', { placeholder: 'Click to add description...' })}
        </div>

        <!-- More details toggle -->
        <button class="show-more-toggle" style="margin-top:0.75rem" @click="more = !more">
          <span x-text="more ? '&#9662; Less details' : '&#9656; More details'"></span>
        </button>
        <div x-show="more" x-cloak>
          <div class="detail-grid" style="margin-top:0.25rem">
            <div class="detail-pair">
              <span class="detail-label">Probability</span>
              <span class="detail-value">${inlineText('probability', opp.probability != null ? `${opp.probability}` : '', { placeholder: '—', inputType: 'number' })}</span>
            </div>
            <div class="detail-pair">
              <span class="detail-label">RFQ format</span>
              <span class="detail-value">${inlineSelect('rfq_format', opp.rfq_format, RFQ_FORMAT_OPTIONS)}</span>
            </div>
            <div class="detail-pair">
              <span class="detail-label">Source</span>
              <span class="detail-value">${inlineSelect('source', opp.source, SOURCE_OPTIONS)}</span>
            </div>
            <div class="detail-pair">
              <span class="detail-label">Salesperson</span>
              <span class="detail-value">${inlineSelect('salesperson_user_id', opp.salesperson_user_id, userOptions)}</span>
            </div>
            <div class="detail-pair">
              <span class="detail-label">RFI due</span>
              <span class="detail-value">${inlineDate('rfi_due_date', opp.rfi_due_date)}</span>
            </div>
            ${!opp.customer_po_number ? html`
            <div class="detail-pair">
              <span class="detail-label">Customer PO</span>
              <span class="detail-value">${inlineText('customer_po_number', '', { placeholder: '—' })}</span>
            </div>` : ''}
            ${!opp.quoted_date ? html`
            <div class="detail-pair">
              <span class="detail-label">Quoted</span>
              <span class="detail-value">${inlineDate('quoted_date', opp.quoted_date)}</span>
            </div>` : ''}
            ${!opp.expected_close_date ? html`
            <div class="detail-pair">
              <span class="detail-label">Expected close</span>
              <span class="detail-value">${inlineDate('expected_close_date', opp.expected_close_date)}</span>
            </div>` : ''}
          </div>

          <!-- BANT -->
          <strong style="font-size:0.85em; display:block; margin-top:0.5rem">Qualification (BANT)</strong>
          <div class="detail-grid" style="margin-top:0.25rem">
            <div class="detail-pair">
              <span class="detail-label">Budget</span>
              <span class="detail-value">${inlineSelect('bant_budget', opp.bant_budget, BANT_BUDGET_OPTIONS)}</span>
            </div>
            <div class="detail-pair">
              <span class="detail-label">Authority</span>
              <span class="detail-value">${inlineSelect('bant_authority_contact_id', opp.bant_authority_contact_id, contactOptions)}</span>
            </div>
            <div class="detail-pair">
              <span class="detail-label">Need</span>
              <span class="detail-value">${inlineText('bant_need', opp.bant_need ?? '', { placeholder: '—' })}</span>
            </div>
            <div class="detail-pair">
              <span class="detail-label">Timeline</span>
              <span class="detail-value">${inlineText('bant_timeline', opp.bant_timeline ?? '', { placeholder: '—' })}</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    ${contacts.length > 0
      ? html`
        <section class="card">
          <div class="card-header">
            <h2>Contacts on ${escape(opp.account_name ?? 'this account')}</h2>
            <a class="btn btn-sm" href="/accounts/${escape(opp.account_id)}/contacts/new">Add contact</a>
          </div>
          <table class="data compact">
            <thead><tr><th>Name</th><th>Title</th><th>Email</th><th>Phone</th><th></th></tr></thead>
            <tbody>
              ${contacts.map(c => {
                const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || '(no name)';
                return html`<tr>
                  <td><strong>${escape(name)}</strong></td>
                  <td>${escape(c.title ?? '')}</td>
                  <td>${c.email ? html`<a href="mailto:${escape(c.email)}">${escape(c.email)}</a>` : ''}</td>
                  <td>${escape(c.phone ?? '')}</td>
                  <td>${c.is_primary ? html`<span class="pill pill-success">primary</span>` : ''}</td>
                </tr>`;
              })}
            </tbody>
          </table>
        </section>`
      : ''}
  `;

  // ---- Price builds tab --------------------------------------------------
  const costTab = html`
    <section class="card">
      <div class="card-header"><h2>Price builds</h2></div>
      <p class="muted">Price builds are per line item on each quote. This tab shows a rollup across all quotes.</p>
      ${priceBuildRows.length === 0
        ? html`<p class="muted">No price builds yet.</p>`
        : html`
          <table class="data">
            <thead><tr><th>Label</th><th>Quote</th><th>Line</th><th>Status</th><th class="num">Cost</th><th class="num">Price</th><th class="num">Margin</th><th></th></tr></thead>
            <tbody>
              ${priceBuildRows.map(({ row, result }) => {
                const marg = result.pricing.margin;
                const pillClass = marg.status === 'good' ? 'pill pill-success' : marg.status === 'low' ? 'pill pill-warn' : 'pill';
                const marginCell = marg.amount !== null ? html`<span class="${pillClass}">${fmtDollar(marg.amount)} (${fmtPct(marg.pct)})</span>` : '\u2014';
                const pbUrl = `/opportunities/${opp.id}/quotes/${row.quote_id}/lines/${row.quote_line_id}/price-build`;
                return html`<tr>
                  <td><a href="${pbUrl}">${escape(row.label || '(unlabeled)')}</a></td>
                  <td><a href="/opportunities/${escape(opp.id)}/quotes/${escape(row.quote_id)}">${escape(row.quote_number)} Rev ${escape(row.quote_revision)}</a></td>
                  <td>${escape(row.line_description || '')}</td>
                  <td><span class="pill ${row.status === 'locked' ? 'pill-locked' : ''}">${escape(row.status)}</span></td>
                  <td class="num">${fmtDollar(result.pricing.effective.totalCost)}</td>
                  <td class="num">${fmtDollar(result.pricing.effective.quote)}</td>
                  <td class="num">${marginCell}</td>
                  <td class="row-actions"><a class="btn small" href="${pbUrl}">${row.status === 'locked' ? 'View' : 'Edit'}</a></td>
                </tr>`;
              })}
            </tbody>
          </table>`}
    </section>`;

  // ---- Quotes tab --------------------------------------------------------
  const quoteTypeOptions = allowedQuoteTypes(opp.transaction_type);  // handles comma-separated
  const quotesTab = html`
    <section class="card">
      <div class="card-header">
        <h2>Quotes</h2>
        <form method="post" action="/opportunities/${escape(opp.id)}/quotes" class="inline-form quotes-new-form">
          <input type="hidden" name="quote_type" value="${escape(quoteTypeOptions[0] || 'spares')}">
          <button class="btn primary" type="submit">+ New quote</button>
        </form>
      </div>
      ${quoteRows.length === 0
        ? html`<p class="muted">No quotes yet.</p>`
        : html`
          <table class="data">
            <thead><tr><th>Number</th><th>Rev</th><th>Type</th><th>Title</th><th>Status</th><th class="num">Total</th><th>Valid until</th><th></th></tr></thead>
            <tbody>
              ${quoteRows.map(q => {
                const statusClass = quoteStatusPillClass(q.status);
                return html`<tr>
                  <td><code>${escape(q.number)}</code></td>
                  <td>${escape(q.revision)}</td>
                  <td>${escape(QUOTE_TYPE_LABELS[q.quote_type] ?? q.quote_type)}</td>
                  <td><a href="/opportunities/${escape(opp.id)}/quotes/${escape(q.id)}">${escape(q.title || '(no title)')}</a></td>
                  <td><span class="pill ${statusClass}">${escape(QUOTE_STATUS_LABELS[q.status] ?? q.status)}</span></td>
                  <td class="num">${fmtDollar(q.total_price)}</td>
                  <td><small class="muted">${escape(q.valid_until ?? '—')}</small></td>
                  <td class="row-actions"><a class="btn small" href="/opportunities/${escape(opp.id)}/quotes/${escape(q.id)}">Open</a></td>
                </tr>`;
              })}
            </tbody>
          </table>`}
    </section>`;

  // ---- Tasks tab ---------------------------------------------------------
  const TASK_TYPE_LABELS = { task: 'Task', note: 'Note', email: 'Email', call: 'Call', meeting: 'Meeting' };
  const tasksTab = html`
    <section class="card">
      <div class="card-header"><h2>Tasks & Activities</h2></div>
      <div style="margin-bottom:1rem; padding:0.75rem; background:var(--bg-muted,#f6f8fa); border-radius:var(--radius);">
        <form method="post" action="/activities">
          <input type="hidden" name="opportunity_id" value="${escape(opp.id)}">
          <input type="hidden" name="return_to" value="/opportunities/${escape(opp.id)}?tab=tasks">
          <div style="display:grid; grid-template-columns:auto 1fr auto auto; gap:0.5rem; align-items:end;">
            <select name="type" style="font-size:0.85em">
              <option value="task">Task</option><option value="note">Note</option>
              <option value="email">Email</option><option value="call">Call</option>
              <option value="meeting">Meeting</option>
            </select>
            <input type="text" name="subject" placeholder="Subject..." required style="width:100%; font-size:0.85em">
            <input type="date" name="due_at" style="font-size:0.85em">
            <button class="btn btn-sm primary" type="submit">Add</button>
          </div>
        </form>
      </div>
      ${taskRows.length === 0
        ? html`<p class="muted">No tasks or activities yet.</p>`
        : html`
          <table class="data compact">
            <thead><tr><th style="width:2rem"></th><th>Subject</th><th>Type</th><th>Assigned</th><th>Due</th><th>Status</th></tr></thead>
            <tbody>
              ${taskRows.map(a => {
                const isOverdue = a.status === 'pending' && a.due_at && a.due_at < new Date().toISOString().slice(0, 10);
                return html`<tr class="${a.status === 'completed' ? 'row-muted' : ''} ${isOverdue ? 'row-overdue' : ''}">
                  <td>${a.status === 'pending'
                    ? html`<form method="post" action="/activities/${escape(a.id)}/complete" style="display:inline"><button type="submit" class="check-btn" title="Mark complete"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="6"/></svg></button></form>`
                    : html`<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--green,#1a7f37)" stroke-width="2"><circle cx="8" cy="8" r="6"/><path d="M5 8l2 2 4-4"/></svg>`}</td>
                  <td><a href="/activities/${escape(a.id)}"><strong class="${a.status === 'completed' ? 'completed-text' : ''}">${escape(a.subject || '(no subject)')}</strong></a>
                    ${a.body ? html`<br><small class="muted">${escape(a.body.length > 60 ? a.body.slice(0, 60) + '...' : a.body)}</small>` : ''}</td>
                  <td><span class="pill pill-${a.type}">${escape(TASK_TYPE_LABELS[a.type] ?? a.type)}</span></td>
                  <td>${escape(a.assigned_name ?? a.assigned_email ?? '—')}</td>
                  <td class="${isOverdue ? 'overdue-text' : ''}">${a.due_at ? escape(a.due_at.slice(0, 10)) : html`<span class="muted">—</span>`}</td>
                  <td><span class="pill ${a.status === 'completed' ? 'pill-success' : ''}">${escape(a.status ?? '—')}</span></td>
                </tr>`;
              })}
            </tbody>
          </table>`}
    </section>`;

  // ---- Docs tab ----------------------------------------------------------
  const DOC_KIND_LABELS = {
    rfq: 'RFQ', rfi: 'RFI', quote_pdf: 'Quote PDF', po: 'PO',
    oc_pdf: 'OC PDF', ntp_pdf: 'NTP PDF', drawing: 'Drawing',
    specification: 'Specification', supplier_quote: 'Supplier Quote',
    image: 'Image / Photo', other: 'Other',
  };
  const docsTab = html`
    <section class="card">
      <div class="card-header"><h2>Documents</h2></div>
      <div x-data="dropUpload()" style="margin-bottom:1rem;">
        <form method="post" action="/documents" enctype="multipart/form-data" x-ref="uploadForm">
          <input type="hidden" name="opportunity_id" value="${escape(opp.id)}">
          <input type="hidden" name="return_to" value="/opportunities/${escape(opp.id)}?tab=docs">
          <div class="drop-zone" :class="{ 'drop-zone-active': dragging }"
               @dragover.prevent="dragging = true"
               @dragleave.prevent="dragging = false"
               @drop.prevent="handleDrop($event)"
               @click="$refs.fileInput.click()">
            <input type="file" name="file" required x-ref="fileInput" hidden @change="fileSelected($event)">
            <div class="drop-zone-content">
              <span x-show="!fileName" class="muted">Drop file here or click to browse</span>
              <span x-show="fileName" x-text="fileName" style="font-weight:500"></span>
            </div>
          </div>
          <div style="margin-top:0.4rem; display:grid; grid-template-columns:auto 1fr 1fr auto; gap:0.5rem; align-items:end;">
            <div><label class="field-label">Kind</label>
              <select name="kind" style="font-size:0.85em">${Object.entries(DOC_KIND_LABELS).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></div>
            <div><input type="text" name="title" placeholder="Title (defaults to filename)" style="width:100%; font-size:0.85em"></div>
            <div><input type="text" name="notes" placeholder="Notes (optional)" style="width:100%; font-size:0.85em"></div>
            <div><button class="btn btn-sm primary" type="submit">Upload</button></div>
          </div>
        </form>
      </div>
      ${docRows.length === 0
        ? html`<p class="muted">No documents yet.</p>`
        : html`
          <table class="data compact">
            <thead><tr><th>Title</th><th>Kind</th><th>Size</th><th>Uploaded</th><th>By</th><th></th></tr></thead>
            <tbody>
              ${docRows.map(d => {
                const kindOpts = JSON.stringify(Object.entries(DOC_KIND_LABELS).map(([k, v]) => ({ value: k, label: v })));
                return html`<tr x-data="docInline('${escape(d.id)}')">
                <td>
                  <span class="ie" data-field="title" data-type="text" @click="activate($el)">
                    <span class="ie-display"><strong>${escape(d.title)}</strong></span>
                  </span>
                  ${d.original_filename ? html`<br><small class="muted">${escape(d.original_filename)}</small>` : ''}
                </td>
                <td>
                  <span class="ie" data-field="kind" data-type="select" data-options='${escape(kindOpts)}' @click="activate($el)">
                    <span class="ie-display"><span class="pill">${escape(DOC_KIND_LABELS[d.kind] ?? d.kind)}</span></span>
                    <span class="ie-raw" hidden>${escape(d.kind)}</span>
                  </span>
                </td>
                <td><small>${escape(fmtSize(d.size_bytes))}</small></td>
                <td><small class="muted">${escape((d.uploaded_at ?? '').slice(0, 10))}</small></td>
                <td><small>${escape(d.uploaded_by_name ?? d.uploaded_by_email ?? '—')}</small></td>
                <td class="row-actions">
                  <a class="btn small" href="/documents/${escape(d.id)}/download">Download</a>
                  <form method="post" action="/documents/${escape(d.id)}/replace" style="display:inline" enctype="multipart/form-data">
                    <input type="hidden" name="return_to" value="/opportunities/${escape(opp.id)}?tab=docs">
                    <label class="btn small" style="cursor:pointer">Replace<input type="file" name="file" hidden onchange="this.form.submit()"></label>
                  </form>
                  <form method="post" action="/documents/${escape(d.id)}/delete" style="display:inline" onsubmit="return confirm('Delete this document?')">
                    <input type="hidden" name="return_to" value="/opportunities/${escape(opp.id)}?tab=docs">
                    <button class="btn small danger" type="submit">Delete</button>
                  </form>
                </td>
              </tr>`; })
            }</tbody>
          </table>`}
    </section>`;

  // ---- History tab (audit events) ----------------------------------------
  const historyTab = html`
    <section class="card">
      <h2>History</h2>
      ${events.length === 0
        ? html`<p class="muted">No history recorded yet.</p>`
        : html`
          <ul class="activity">
            ${events.map(e => {
              const who = e.user_name ?? e.user_email ?? 'system';
              const when = formatTimestamp(e.at);
              const summary = e.summary ?? `${e.event_type}`;
              const changes = parseChanges(e.changes_json);
              return html`<li>
                <div class="activity-head">
                  <strong>${escape(who)}</strong>
                  <span class="activity-type">${escape(e.event_type)}</span>
                  <span class="activity-when muted">${escape(when)}</span>
                </div>
                <div>${escape(summary)}</div>
                ${e.override_reason ? html`<div class="activity-changes"><small class="muted">Reason: ${escape(e.override_reason)}</small></div>` : ''}
                ${changes ? html`<div class="activity-changes">${changes.map(c => html`
                  <div><small class="muted"><code>${escape(c.field)}</code>: ${escape(fmtChangeValue(c.from))} → ${escape(fmtChangeValue(c.to))}</small></div>
                `)}</div>` : ''}
              </li>`;
            })}
          </ul>`}
    </section>`;

  // ---- Tab nav -----------------------------------------------------------
  const tabs = html`
    <nav class="card" style="padding: 0.5rem 1rem;">
      <a class="nav-link ${tab === 'overview' ? 'active' : ''}" href="/opportunities/${escape(opp.id)}">Overview</a>
      <a class="nav-link ${tab === 'quotes' ? 'active' : ''}" href="/opportunities/${escape(opp.id)}?tab=quotes">Quotes (${quoteBadgeCount})</a>
      <a class="nav-link ${tab === 'cost' ? 'active' : ''}" href="/opportunities/${escape(opp.id)}?tab=cost">Price builds (${priceBuildBadgeCount})</a>
      <a class="nav-link ${tab === 'tasks' ? 'active' : ''}" href="/opportunities/${escape(opp.id)}?tab=tasks">Tasks${taskBadgeCount > 0 ? ` (${taskBadgeCount})` : ''}</a>
      <a class="nav-link ${tab === 'docs' ? 'active' : ''}" href="/opportunities/${escape(opp.id)}?tab=docs">Docs${docBadgeCount > 0 ? ` (${docBadgeCount})` : ''}</a>
      <a class="nav-link ${tab === 'history' ? 'active' : ''}" href="/opportunities/${escape(opp.id)}?tab=history">History (${events.length})</a>
    </nav>`;

  const body = html`${tabs}${
    tab === 'history' ? historyTab :
    tab === 'tasks' ? tasksTab :
    tab === 'docs' ? docsTab :
    tab === 'cost' ? costTab :
    tab === 'quotes' ? quotesTab :
    overviewTab
  }`;

  // Inline-edit + carousel scripts
  const scripts = (tab === 'overview' || tab === 'docs') ? html`<script>${raw(inlineEditScript())}</script>` : '';

  return htmlResponse(
    layout(`${opp.number} — ${opp.title}`, html`${body}${scripts}`, {
      user,
      env: data?.env,
      activeNav: '/opportunities',
      flash: readFlash(url),
      breadcrumbs: [
        { label: 'Opportunities', href: '/opportunities' },
        { label: `${opp.number} — ${opp.title}` },
      ],
    })
  );
}

// ---- POST handler (full edit form — kept for backwards compat) -----------

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const oppId = params.id;

  const before = await one(env.DB, `SELECT * FROM opportunities WHERE id = ?`, [oppId]);
  if (!before) return notFound(context);

  const input = await formBody(request);
  const { ok, value, errors } = validateOpportunity(input);
  if (!ok) {
    const { renderEditForm } = await import('./edit.js');
    return renderEditForm(context, {
      opportunity: { ...before, ...input },
      errors,
    });
  }

  const nextNum = value.number == null || value.number === '' ? before.number : value.number;
  const ts = now();
  const after = { ...value, number: nextNum };
  const changes = diff(before, after, UPDATE_FIELDS);

  try {
    await batch(env.DB, [
      stmt(
        env.DB,
        `UPDATE opportunities
            SET number = ?, title = ?, account_id = ?, primary_contact_id = ?, description = ?,
                transaction_type = ?, rfq_format = ?, source = ?,
                estimated_value_usd = ?, probability = ?,
                expected_close_date = ?, rfq_received_date = ?, rfq_due_date = ?,
                rfi_due_date = ?, quoted_date = ?,
                bant_budget = ?, bant_authority = ?, bant_authority_contact_id = ?,
                bant_need = ?, bant_timeline = ?,
                owner_user_id = ?, salesperson_user_id = ?,
                customer_po_number = ?,
                updated_at = ?
          WHERE id = ?`,
        [
          nextNum, value.title, value.account_id, value.primary_contact_id, value.description,
          value.transaction_type, value.rfq_format, value.source,
          value.estimated_value_usd, value.probability,
          value.expected_close_date, value.rfq_received_date, value.rfq_due_date,
          value.rfi_due_date, value.quoted_date,
          value.bant_budget, value.bant_authority, value.bant_authority_contact_id,
          value.bant_need, value.bant_timeline,
          value.owner_user_id, value.salesperson_user_id,
          value.customer_po_number,
          ts, oppId,
        ]
      ),
      auditStmt(env.DB, {
        entityType: 'opportunity',
        entityId: oppId,
        eventType: 'updated',
        user,
        summary: `Updated ${nextNum}`,
        changes,
      }),
    ]);
  } catch (e) {
    if (isUniqueNumberError(e)) {
      const { renderEditForm } = await import('./edit.js');
      return renderEditForm(context, {
        opportunity: { ...before, ...input },
        errors: { number: 'That number is already in use' },
      });
    }
    throw e;
  }

  return redirectWithFlash(`/opportunities/${oppId}`, `Saved.`);
}

function isUniqueNumberError(e) {
  const msg = String(e?.message ?? e ?? '');
  return /UNIQUE/i.test(msg) && /opportunities\.number|opportunities_number|\.number/i.test(msg);
}

// -- helpers ---------------------------------------------------------------

function fmtSize(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMoney(n) {
  return Math.round(Number(n)).toLocaleString('en-US');
}

function quoteStatusPillClass(status) {
  switch (status) {
    case 'draft': case 'revision_draft': return '';
    case 'issued': case 'revision_issued': return 'pill-warn';
    case 'accepted': return 'pill-success';
    case 'rejected': case 'expired': case 'dead': return 'pill-locked';
    default: return '';
  }
}

function formatTimestamp(iso) {
  if (!iso) return '';
  return iso.replace('T', ' ').replace(/\.\d+Z?$/, '').slice(0, 16);
}

function parseChanges(json) {
  if (!json) return null;
  let obj;
  try { obj = JSON.parse(json); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const keys = Object.keys(obj).filter(k => k !== 'gate_warnings');
  if (!keys.length) return null;
  const isDiff = keys.every(k => obj[k] && typeof obj[k] === 'object' && 'from' in obj[k] && 'to' in obj[k]);
  if (!isDiff) return null;
  return keys.map(k => ({ field: k, from: obj[k].from, to: obj[k].to }));
}

function fmtChangeValue(v) {
  if (v === null || v === undefined || v === '') return '(empty)';
  return String(v);
}

function notFound(context) {
  return htmlResponse(
    layout('Opportunity not found',
      `<section class="card"><h1>Opportunity not found</h1><p><a href="/opportunities">Back to opportunities</a></p></section>`,
      { user: context.data?.user, env: context.data?.env, activeNav: '/opportunities' }),
    { status: 404 }
  );
}

// ---- Client-side scripts -------------------------------------------------

function inlineEditScript() {
  return `
// Stage carousel component — shows prev/current/next via x-show
function stageCarousel(startIdx, count) {
  return {
    idx: startIdx,
    max: count,
    closingStage: '',
    prev() { if (this.idx > 0) this.idx--; },
    next() { if (this.idx < this.max - 1) this.idx++; },
    showCloseReason(stage) {
      this.closingStage = stage;
      this.$nextTick(() => this.$refs.closeReasonInput?.focus());
    },
  };
}

// Inline-edit controller
function oppInline(oppId, accountId) {
  const patchUrl = '/opportunities/' + oppId + '/patch';
  return {
    saving: false,
    init() {
      this.$el.querySelectorAll('.ie').forEach(el => {
        el.addEventListener('click', () => this.activate(el));
      });
    },
    activate(el) {
      if (el.querySelector('.ie-input')) return; // already active
      const field = el.dataset.field;
      const type = el.dataset.type;
      const display = el.querySelector('.ie-display');
      const rawEl = el.querySelector('.ie-raw');
      const currentValue = rawEl ? rawEl.textContent : (display.classList.contains('muted') ? '' : display.textContent.trim());

      let input;
      if (type === 'select') {
        input = document.createElement('select');
        input.className = 'ie-input';
        const options = JSON.parse(el.dataset.options || '[]');
        options.forEach(o => {
          const opt = document.createElement('option');
          opt.value = o.value;
          opt.textContent = o.label;
          if (o.value === (currentValue || '')) opt.selected = true;
          input.appendChild(opt);
        });
        input.addEventListener('change', () => {
          if (input.value === '__new__') {
            this.showNewContactForm(el, input);
          } else {
            this.save(el, input);
          }
        });
        input.addEventListener('blur', (e) => {
          // Don't deactivate if focus moved to the new-contact form
          if (e.relatedTarget && el.contains(e.relatedTarget)) return;
          setTimeout(() => {
            if (!el.querySelector('.ie-new-contact')) this.deactivate(el, input);
          }, 150);
        });
      } else if (type === 'textarea') {
        input = document.createElement('textarea');
        input.className = 'ie-input';
        input.rows = 3;
        input.value = currentValue;
        input.addEventListener('blur', () => this.save(el, input));
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { this.deactivate(el, input); }
        });
      } else if (type === 'date') {
        input = document.createElement('input');
        input.type = 'date';
        input.className = 'ie-input';
        input.value = currentValue;
        input.addEventListener('change', () => this.save(el, input));
        input.addEventListener('blur', () => this.save(el, input));
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
        if (el.dataset.type === 'select') {
          const options = JSON.parse(el.dataset.options || '[]');
          const opt = options.find(o => o.value === (data.value || ''));
          display.textContent = opt ? opt.label : (data.value || '—');
        } else if (field === 'estimated_value_usd' && data.value != null) {
          display.textContent = '$' + Math.round(Number(data.value)).toLocaleString('en-US');
        } else {
          display.textContent = data.value || '—';
        }
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
    showNewContactForm(el, selectInput) {
      if (el.querySelector('.ie-new-contact')) return;
      selectInput.style.display = 'none';
      const form = document.createElement('div');
      form.className = 'ie-new-contact';
      form.innerHTML = '<div style="display:flex;gap:0.3rem;align-items:center;flex-wrap:wrap;margin-top:0.3rem">'
        + '<input type="text" class="ie-input" placeholder="First name" style="flex:1;min-width:80px" data-nc="first">'
        + '<input type="text" class="ie-input" placeholder="Last name" style="flex:1;min-width:80px" data-nc="last">'
        + '<button type="button" class="btn btn-sm primary" data-nc="save">Save</button>'
        + '<button type="button" class="btn btn-sm" data-nc="cancel">Cancel</button>'
        + '</div>';
      el.appendChild(form);
      form.querySelector('[data-nc="first"]').focus();
      form.querySelector('[data-nc="cancel"]').addEventListener('click', () => {
        form.remove();
        this.deactivate(el, selectInput);
      });
      form.querySelector('[data-nc="save"]').addEventListener('click', async () => {
        const firstName = form.querySelector('[data-nc="first"]').value.trim();
        const lastName = form.querySelector('[data-nc="last"]').value.trim();
        if (!firstName && !lastName) return;
        try {
          const res = await fetch('/api/accounts/' + accountId + '/contacts-create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ first_name: firstName, last_name: lastName }),
          });
          const data = await res.json();
          if (!data.ok) { alert(data.error || 'Failed'); return; }
          const newId = data.contact.id;
          const newLabel = [firstName, lastName].filter(Boolean).join(' ');
          form.remove();
          selectInput.style.display = '';
          const newOpt = document.createElement('option');
          newOpt.value = newId;
          newOpt.textContent = newLabel;
          const newEntry = selectInput.querySelector('option[value="__new__"]');
          if (newEntry) selectInput.insertBefore(newOpt, newEntry);
          else selectInput.appendChild(newOpt);
          selectInput.value = newId;
          // Update options data for future opens
          const opts = JSON.parse(el.dataset.options || '[]');
          opts.splice(opts.length - 1, 0, { value: newId, label: newLabel });
          el.dataset.options = JSON.stringify(opts);
          // Sync other contact selects on the page
          this.$el.querySelectorAll('.ie[data-field="primary_contact_id"], .ie[data-field="bant_authority_contact_id"]').forEach(otherEl => {
            if (otherEl === el) return;
            const otherOpts = JSON.parse(otherEl.dataset.options || '[]');
            otherOpts.splice(otherOpts.length - 1, 0, { value: newId, label: newLabel });
            otherEl.dataset.options = JSON.stringify(otherOpts);
          });
          this.save(el, selectInput);
        } catch (err) {
          alert('Error creating contact');
        }
      });
    },
    deactivate(el, input) {
      if (input && input.parentNode === el) el.removeChild(input);
      el.querySelectorAll('.ie-new-contact').forEach(f => f.remove());
      const display = el.querySelector('.ie-display');
      if (display) display.style.display = '';
    },
  };
}

// Drop-zone file upload
function dropUpload() {
  return {
    dragging: false,
    fileName: '',
    handleDrop(e) {
      this.dragging = false;
      const files = e.dataTransfer?.files;
      if (files?.length) {
        this.$refs.fileInput.files = files;
        this.fileName = files[0].name;
      }
    },
    fileSelected(e) {
      const f = e.target.files?.[0];
      this.fileName = f ? f.name : '';
    },
  };
}

// Per-row inline-edit for documents
function docInline(docId) {
  const patchUrl = '/documents/' + docId + '/patch';
  return {
    activate(el) {
      if (el.querySelector('.ie-input')) return;
      const field = el.dataset.field;
      const type = el.dataset.type;
      const display = el.querySelector('.ie-display');
      const rawEl = el.querySelector('.ie-raw');
      const currentValue = rawEl ? rawEl.textContent : display.textContent.trim();

      let input;
      if (type === 'select') {
        input = document.createElement('select');
        input.className = 'ie-input';
        const options = JSON.parse(el.dataset.options || '[]');
        options.forEach(o => {
          const opt = document.createElement('option');
          opt.value = o.value;
          opt.textContent = o.label;
          if (o.value === (currentValue || '')) opt.selected = true;
          input.appendChild(opt);
        });
        input.addEventListener('change', () => this.save(el, input));
        input.addEventListener('blur', () => this.deactivate(el, input));
      } else {
        input = document.createElement('input');
        input.type = 'text';
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
        const display = el.querySelector('.ie-display');
        const rawEl = el.querySelector('.ie-raw');
        if (el.dataset.type === 'select') {
          const options = JSON.parse(el.dataset.options || '[]');
          const opt = options.find(o => o.value === (data.value || ''));
          const pill = display.querySelector('.pill') || display;
          pill.textContent = opt ? opt.label : (data.value || '—');
        } else {
          const strong = display.querySelector('strong') || display;
          strong.textContent = data.value || '—';
        }
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
      if (input && input.parentNode === el) el.removeChild(input);
      const display = el.querySelector('.ie-display');
      if (display) display.style.display = '';
    },
  };
}

// Multi-type picker for opportunity transaction_type
function oppTypePicker(initial, oppId) {
  return {
    selected: initial ? initial.split(',').map(function(s){ return s.trim(); }).filter(Boolean) : [],
    allTypes: [
      { value: 'spares', label: 'Spares' },
      { value: 'eps', label: 'EPS' },
      { value: 'refurb', label: 'Refurb' },
      { value: 'service', label: 'Service' },
    ],
    toggle(val) {
      var idx = this.selected.indexOf(val);
      if (idx === -1) this.selected.push(val);
      else if (this.selected.length > 1) this.selected.splice(idx, 1);
      // Don't allow deselecting the last type
      this.save();
    },
    save() {
      var csv = this.selected.join(',');
      fetch('/opportunities/' + oppId + '/patch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field: 'transaction_type', value: csv }),
      });
    },
  };
}
`;
}
