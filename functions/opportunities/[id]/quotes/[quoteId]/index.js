// functions/opportunities/[id]/quotes/[quoteId]/index.js
//
// GET  /opportunities/:id/quotes/:quoteId  — quote detail / editor
// POST /opportunities/:id/quotes/:quoteId  — update header fields (form fallback)
//
// Layout (5 cards):
//   1. Header — quote#, status pill, total, contextual action buttons
//   2. Banner — "QUOTATION" + type, logo
//   3. Details — address selector left, quote meta right, description
//   4. Line items — table with item notes
//   5. Footer — customer notes, terms, internal notes
//
// Auto-save: all fields save via fetch POST to ./patch on change.
// No "Save" button. Header shows contextual actions based on status.

import { one, all, stmt, batch } from '../../../../lib/db.js';
import { auditStmt, diff } from '../../../../lib/audit.js';
import { now } from '../../../../lib/ids.js';
import { layout, htmlResponse, html, raw, escape } from '../../../../lib/layout.js';
import { redirectWithFlash, formBody, readFlash } from '../../../../lib/http.js';
import {
  validateQuote,
  allowedQuoteTypes,
  parseTransactionTypes,
  parseQuoteTypes,
  isHybridQuote,
  quoteTypeDisplayLabel,
  QUOTE_TYPE_LABELS,
  QUOTE_STATUS_LABELS,
} from '../../../../lib/validators.js';
import {
  fmtDollar,
  quoteTotalsRecomputeStmt,
  computeDiscountApplied,
  readDiscountFromRow,
} from '../../../../lib/pricing.js';
import { templateTypeForQuote, templateManagerHtml } from '../../../../lib/template-catalog.js';
import { loadQuoteTermDefaultsMap } from '../../../../lib/quote-term-defaults.js';

const READ_ONLY_STATUSES = new Set([
  'issued', 'revision_issued', 'accepted', 'rejected', 'expired', 'dead',
]);

const UPDATE_FIELDS = [
  'quote_type', 'title', 'description', 'valid_until', 'incoterms',
  'payment_terms', 'delivery_terms', 'delivery_estimate',
  'tax_amount', 'notes_internal', 'notes_customer',
];

export async function onRequestGet(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  // Per-user preference (migration 0026) — hides the discount UI when
  // false but stored data is preserved and still applied to totals.
  const showDiscounts = user?.show_discounts === 1 || user?.show_discounts === true;
  const url = new URL(request.url);
  const oppId = params.id;
  const quoteId = params.quoteId;

  const quote = await one(
    env.DB,
    `SELECT q.*, o.number AS opp_number, o.title AS opp_title,
            o.transaction_type AS opp_transaction_type,
            o.account_id,
            a.name AS account_name,
            c.first_name AS contact_first, c.last_name AS contact_last,
            c.email AS contact_email, c.phone AS contact_phone, c.title AS contact_title,
            sup.number AS supersedes_number, sup.revision AS supersedes_revision,
            subu.display_name AS submitted_by_name, subu.email AS submitted_by_email
       FROM quotes q
       LEFT JOIN opportunities o ON o.id = q.opportunity_id
       LEFT JOIN accounts a      ON a.id = o.account_id
       LEFT JOIN contacts c      ON c.id = o.primary_contact_id
       LEFT JOIN quotes sup      ON sup.id = q.supersedes_quote_id
       LEFT JOIN users subu      ON subu.id = q.submitted_by_user_id
      WHERE q.id = ?`,
    [quoteId]
  );
  if (!quote || quote.opportunity_id !== oppId) return notFound(context);

  // All addresses for the account (for the selector)
  const addresses = quote.account_id
    ? await all(
        env.DB,
        `SELECT id, kind, label, address, is_default
           FROM account_addresses
          WHERE account_id = ?
          ORDER BY kind, is_default DESC, label`,
        [quote.account_id]
      )
    : [];

  const lines = await all(
    env.DB,
    `SELECT ql.*, cb.label AS price_build_label, cb.status AS price_build_status,
            cb.quote_price_user AS build_quote_price, cb.number AS build_number
       FROM quote_lines ql
       LEFT JOIN cost_builds cb ON cb.quote_line_id = ql.id
      WHERE ql.quote_id = ?
      ORDER BY ql.sort_order, ql.id`,
    [quoteId]
  );

  const revisionHistory = await all(
    env.DB,
    `SELECT id, number, revision, status, created_at
       FROM quotes
      WHERE opportunity_id = ? AND quote_seq = ?
      ORDER BY created_at`,
    [oppId, quote.quote_seq]
  );

  const generatedDocs = await all(
    env.DB,
    `SELECT id, kind, original_filename, size_bytes, uploaded_at
       FROM documents
      WHERE quote_id = ? AND kind IN ('quote_pdf', 'quote_docx')
      ORDER BY uploaded_at DESC`,
    [quoteId]
  );

  // User-editable term defaults (migration 0024). Flat map like
  //   { spares: { payment_terms: '...' }, eps: { delivery_terms: '...' } }
  // Serialized into JS below so the flatTerms / plainTerms Alpine
  // components can consult (or save) defaults without a round-trip.
  const termDefaults = await loadQuoteTermDefaultsMap(env);

  const readOnly = READ_ONLY_STATUSES.has(quote.status);
  const subtotal = lines.reduce((a, l) => a + Number(l.extended_price ?? 0), 0);
  // T3.2 Phase 1 — header-level discount is applied to the full subtotal
  // (same base the server-side recompute uses via SUM(extended_price)).
  // Phantom discounts don't reduce the stored total — they're a
  // render-time markup only. See pricing.js for the details.
  const headerDiscount = readDiscountFromRow(quote);
  const headerDiscountApplied = computeDiscountApplied(headerDiscount, subtotal);
  const total = subtotal - headerDiscountApplied + Number(quote.tax_amount ?? 0);
  const highlightDocId = url.searchParams.get('highlight');
  const flash = highlightDocId ? null : readFlash(url);

  const isDraft = quote.status === 'draft' || quote.status === 'revision_draft';
  const isIssued = quote.status === 'issued' || quote.status === 'revision_issued';

  const patchUrl = `/opportunities/${oppId}/quotes/${quoteId}/patch`;

  // Pick the default address to show
  const defaultAddr = addresses.find(a => a.kind === 'billing' && a.is_default)
    || addresses.find(a => a.is_default)
    || addresses[0]
    || null;

  // ── 1. Header card ─────────────────────────────────────────────────
  const headerSection = html`
    <section class="card">
      <div class="card-header">
        <div>
          <h1 class="page-title">
            ${escape(quote.number)}
            <span class="pill ${statusPillClass(quote.status)}">${escape(QUOTE_STATUS_LABELS[quote.status] ?? quote.status)}</span>
            <span class="header-value" id="q-header-total">${fmtDollar(total)}</span>
          </h1>
          <p class="muted" style="margin:0.15rem 0 0;font-size:0.85em">
            ${escape(quoteTypeDisplayLabel(quote.quote_type))}
            · ${escape(quote.revision)}
            ${quote.title ? html` · ${escape(quote.title)}` : ''}
            ${quote.supersedes_quote_id
              ? html` · supersedes <a href="/opportunities/${escape(oppId)}/quotes/${escape(quote.supersedes_quote_id)}">${escape(quote.supersedes_number ?? '')} ${escape(quote.supersedes_revision ?? '')}</a>`
              : ''}
          </p>
        </div>
        <div class="header-actions-stack">
          <a class="back-link" href="/opportunities/${escape(quote.opportunity_id)}?tab=quotes">\u2190 Quotes</a>
          <div class="header-actions">
            ${isDraft ? html`
              <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/submit" class="inline-form">
                <button class="btn primary" type="submit">Issue</button>
              </form>
            ` : ''}
            ${isIssued ? html`
              <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/revise" class="inline-form">
                <button class="btn" type="submit">Revise</button>
              </form>
              <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/accept" class="inline-form">
                <button class="btn primary" type="submit">Accept</button>
              </form>
              <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/reject" class="inline-form">
                <button class="btn" type="submit">Reject</button>
              </form>
              <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/expire" class="inline-form">
                <button class="btn danger" type="submit">Cancel</button>
              </form>
            ` : ''}
            ${quote.status === 'accepted' || quote.status === 'rejected' || quote.status === 'expired' ? html`
              <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/revise" class="inline-form">
                <button class="btn primary" type="submit">New revision</button>
              </form>
            ` : ''}
            ${isDraft ? html`
              <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/delete"
                    class="inline-form"
                    onsubmit="return confirm('Delete this quote? This cannot be undone.');">
                <button class="btn danger" type="submit">Delete</button>
              </form>
            ` : ''}
            <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/generate-pdf" class="inline-form">
              <button class="btn" type="submit">Generate PDF</button>
            </form>
            <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/generate-docx" class="inline-form">
              <button class="btn" type="submit">Download Word</button>
            </form>
          </div>
        </div>
      </div>

      ${revisionHistory.length > 1
        ? html`
          <div class="revision-strip">
            <strong>Revisions:</strong>
            ${revisionHistory.map((r, i) => html`
              ${i > 0 ? ' · ' : ''}
              ${r.id === quote.id
                ? html`<strong>${escape(r.revision)}</strong>`
                : html`<a href="/opportunities/${escape(oppId)}/quotes/${escape(r.id)}">${escape(r.revision)}</a>`}
              <span class="muted">(${escape(QUOTE_STATUS_LABELS[r.status] ?? r.status)})</span>
            `)}
          </div>`
        : ''}

      ${quote.submitted_at
        ? html`
          <div class="governance-snapshot">
            <p class="muted" style="margin:0">
              Issued ${escape(formatTimestamp(quote.submitted_at))}
              by ${escape(quote.submitted_by_name ?? quote.submitted_by_email ?? 'unknown')}
              · T&amp;Cs ${escape(quote.tc_revision ?? '—')}
              · Warranty ${escape(quote.warranty_revision ?? '—')}
              · Rate Sched ${escape(quote.rate_schedule_revision ?? '—')}
              · SOP ${escape(quote.sop_revision ?? '—')}
            </p>
          </div>`
        : ''}

      ${generatedDocs.length
        ? html`
          <div style="padding:0.5rem 1rem 0.75rem;border-top:1px solid var(--border)">
            <p class="muted" style="margin:0 0 0.35rem;font-size:0.8em;font-weight:600">Generated Documents</p>
            ${generatedDocs.map(d => html`
              <span class="gen-doc-row ${d.id === highlightDocId ? 'gen-doc-highlight' : ''}">
                <a href="/documents/${escape(d.id)}/download" class="gen-doc-link" target="_blank">
                  ${d.kind === 'quote_pdf' ? '📄' : '📝'} ${escape(d.original_filename)}
                  <span class="muted">(${formatSize(d.size_bytes)})</span>
                </a>
                ${!readOnly ? html`
                  <form method="post" action="/documents/${escape(d.id)}/delete" style="display:inline" onsubmit="return confirm('Delete this document?')">
                    <input type="hidden" name="return_to" value="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}">
                    <button type="submit" class="gen-doc-delete" title="Delete">\u00d7</button>
                  </form>` : ''}
              </span>
            `)}
          </div>`
        : ''}
    </section>
  `;

  // ── 2. Banner card ─────────────────────────────────────────────────
  // T3.4 Sub-feature A — if this is a hybrid quote (comma-separated
  // quote_type), render the composite label read-only. Editing the
  // mix post-creation is explicitly out of scope for Sub-feature A —
  // delete the quote and create a new one with a different mix.
  // Single-type quotes retain the existing editable select.
  const quoteTypeOptions = allowedQuoteTypes(quote.opp_transaction_type);
  const isHybrid = isHybridQuote(quote.quote_type);
  const quoteTypeParts = parseQuoteTypes(quote.quote_type);
  const bannerCard = html`
    <section class="card quote-doc-card quote-doc-first quote-banner">
      <div class="quote-banner-inner">
        <div>
          <h2 class="quote-banner-title">QUOTATION</h2>
          ${readOnly || isHybrid
            ? html`<p class="quote-banner-type">${escape(quoteTypeDisplayLabel(quote.quote_type))}${isHybrid ? html` <span class="pill" style="font-size:0.6em;vertical-align:middle">HYBRID</span>` : ''}</p>`
            : html`<select class="quote-banner-type-select"
                           @change="window._qPatch('quote_type', $event.target.value)">
                ${quoteTypeOptions.map(qt => html`
                  <option value="${escape(qt)}" ${qt === quote.quote_type ? 'selected' : ''}>
                    ${escape(QUOTE_TYPE_LABELS[qt] ?? qt)}
                  </option>
                `)}
              </select>`}
        </div>
        <img src="/img/logo-black.png" alt="C-LARS" class="quote-banner-logo">
      </div>
    </section>
  `;

  // ── 3. Details card ────────────────────────────────────────────────
  const addressesJson = JSON.stringify(addresses);

  const detailsSection = html`
    <section class="card quote-doc-card" x-data="quoteDetails()" x-init="init()">
      ${readOnly
        ? html`<p class="muted" style="margin:0 0 0.5rem"><em>This quote is ${escape(quote.status)}. Create a new revision to make changes.</em></p>`
        : ''}
      <div class="quote-meta-grid quote-meta-equal">
        <div class="quote-meta-left">
          <div class="client-info">
            ${quote.account_name
              ? html`<p style="margin:0"><strong><a href="/accounts/${escape(quote.account_id)}">${escape(quote.account_name)}</a></strong></p>`
              : html`<p class="muted" style="margin:0">No account linked</p>`}

            <!-- Address selector -->
            <div style="margin-top:0.35rem">
              <div x-show="!editingAddr" style="cursor:pointer" @click="${readOnly ? '' : 'editingAddr = true'}">
                <pre class="addr" style="margin:0" x-text="selectedAddrText || 'Click to select address'"
                     :class="{ 'muted': !selectedAddrText }"></pre>
              </div>
              <div x-show="editingAddr" x-cloak>
                <select class="meta-input" @change="selectAddress($event.target.value)" x-ref="addrSelect" style="width:100%;margin-bottom:0.3rem">
                  <option value="">-- Select address --</option>
                  ${addresses.map(a => html`
                    <option value="${escape(a.id)}" ${a.id === defaultAddr?.id ? 'selected' : ''}>
                      ${escape(a.label || a.kind)} ${a.is_default ? '(default)' : ''} — ${escape((a.address || '').split('\n')[0])}
                    </option>
                  `)}
                  <option value="__new__">+ Add new address</option>
                </select>
                <div x-show="addingNew" x-cloak>
                  <select class="meta-input" x-model="newAddrKind" style="width:100%;margin-bottom:0.3rem">
                    <option value="billing">Billing</option>
                    <option value="physical">Physical</option>
                  </select>
                  <input type="text" class="meta-input" x-model="newAddrLabel" placeholder="Label (e.g. HQ, Shop)" style="width:100%;margin-bottom:0.3rem">
                  <textarea class="meta-input" x-model="newAddrText" placeholder="Full address" rows="3" style="width:100%;margin-bottom:0.3rem"></textarea>
                  <button class="btn primary small" @click="saveNewAddress()">Save address</button>
                  <button class="btn small" @click="addingNew = false; editingAddr = false">Cancel</button>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="quote-meta-right">
          <table class="quote-meta-table">
            <tr>
              <td class="meta-label">Quote No:</td>
              <td><strong>${escape(quote.number)}</strong></td>
            </tr>
            <tr>
              <td class="meta-label">Date:</td>
              <td>${quote.submitted_at ? escape(formatTimestamp(quote.submitted_at).slice(0, 10)) : html`<span class="muted">Not yet issued</span>`}</td>
            </tr>
            <tr>
              <td class="meta-label">Expiration:</td>
              <td>
                <div x-data="expirationPicker('${escape(quote.valid_until ?? '')}')">
                  <div style="display:flex;gap:0.4rem;align-items:center">
                    <input type="text" x-model="textVal" @change="onTextChange()" class="meta-input" ${readOnly ? 'disabled' : ''} placeholder="e.g. 14 days" style="flex:1">
                    ${!readOnly ? html`
                      <select x-model="daysVal" @change="if(daysVal) setDays(+daysVal)" style="font-size:0.85em;padding:0.2rem 0.3rem;width:auto">
                        <option value="">Days\u2026</option>
                        <option value="7">7 days</option>
                        <option value="14">14 days</option>
                        <option value="21">21 days</option>
                        <option value="30">30 days</option>
                        <option value="45">45 days</option>
                        <option value="60">60 days</option>
                        <option value="90">90 days</option>
                        <option value="120">120 days</option>
                      </select>
                      <input type="date" @change="setDate($event.target.value); $event.target.value=''" class="btn-link-date" title="Pick a date">
                    ` : ''}
                  </div>
                </div>
              </td>
            </tr>
            <tr>
              <td class="meta-label">Delivery:</td>
              <td>
                <div x-data="deliveryPicker('${escape(quote.delivery_estimate ?? '')}')">
                  <div style="display:flex;gap:0.4rem;align-items:center">
                    <input type="text" x-model="textVal" @change="save()" class="meta-input" ${readOnly ? 'disabled' : ''} placeholder="e.g. 12 weeks ARO" style="flex:1">
                    ${!readOnly ? html`
                      <select x-model="weeksVal" @change="if(weeksVal) setWeeks(+weeksVal)" style="font-size:0.85em;padding:0.2rem 0.3rem;width:auto">
                        <option value="">Weeks\u2026</option>
                        ${Array.from({ length: 52 }, (_, i) => i + 1).map(n =>
                          html`<option value="${n}">${n} wk</option>`
                        )}
                      </select>
                      <input type="date" @change="setDate($event.target.value); $event.target.value=''" class="btn-link-date" title="Pick a date">
                    ` : ''}
                  </div>
                </div>
              </td>
            </tr>
          </table>
        </div>
      </div>

      <label class="desc-label">
        Title
        <input type="text" name="title" value="${escape(quote.title ?? '')}"
               placeholder="Quote title / project name"
               class="desc-input"
               ${readOnly ? 'disabled' : ''}
               @change="patchField('title', $event.target.value)">
      </label>
      <label class="desc-label" style="margin-top:0.5rem">
        Description
        <textarea name="description" placeholder="Scope description for the customer" class="desc-textarea"
                  ${readOnly ? 'disabled' : ''}
                  @change="patchField('description', $event.target.value)">${escape(quote.description ?? '')}</textarea>
      </label>
    </section>
  `;

  // ── 4. Line items card ─────────────────────────────────────────────
  const pbUrl = (lineId) => `/opportunities/${oppId}/quotes/${quoteId}/lines/${lineId}/price-build`;
  const optionSubtotal = lines.filter(l => l.is_option).reduce((a, l) => a + Number(l.extended_price ?? 0), 0);
  const includedSubtotal = subtotal - optionSubtotal;

  // T3.4 Sub-feature A — per-section subtotals for hybrid quotes.
  // Sum extended_price of non-option lines grouped by line_type.
  // Unassigned lines (line_type NULL) get their own "Unassigned"
  // bucket so the user can see they still need to be tagged.
  const sectionSubtotals = [];
  if (isHybrid) {
    const bucket = new Map();
    for (const key of quoteTypeParts) {
      bucket.set(key, { key, label: QUOTE_TYPE_LABELS[key] ?? key, total: 0, count: 0 });
    }
    bucket.set('_unassigned', { key: '_unassigned', label: 'Unassigned', total: 0, count: 0 });
    for (const l of lines) {
      if (l.is_option) continue;
      const key = l.line_type && quoteTypeParts.includes(l.line_type) ? l.line_type : '_unassigned';
      const b = bucket.get(key);
      if (b) {
        b.total += Number(l.extended_price ?? 0);
        b.count += 1;
      }
    }
    for (const b of bucket.values()) {
      if (b.count > 0) sectionSubtotals.push(b);
    }
  }
  const hasUnassigned = sectionSubtotals.some(s => s.key === '_unassigned');

  const linesSection = html`
    <section class="card quote-doc-card">
      <div class="card-header">
        <h2>Line items</h2>
        <div class="header-actions">
          <span class="header-value" id="q-lines-subtotal">${fmtDollar(includedSubtotal)} subtotal</span>
        </div>
      </div>

      <table class="data compact quote-lines-table" data-live-calc="quote-lines" id="quote-lines-table">
        <thead>
          <tr>
            <th class="col-num">#</th>
            <th class="col-item">Item</th>
            <th class="num col-qty">Qty</th>
            <th class="col-unit">Unit</th>
            <th class="num col-price">Unit price</th>
            <th class="num col-ext">Price ext</th>
            <th class="col-build">Build</th>
          </tr>
        </thead>
        <tbody>
          ${lines.map((l, i) => {
            const lineHasDiscount =
              l.discount_amount != null ||
              l.discount_pct != null ||
              (l.discount_description && String(l.discount_description).trim() !== '') ||
              l.discount_is_phantom === 1;
            return html`
            <tr data-line-row data-line-id="${escape(l.id)}" class="${l.is_option ? 'line-option' : ''}">
              <td class="col-num">${i + 1}${l.is_option ? html`<br><span class="pill" style="font-size:0.7em">OPT</span>` : ''}</td>
              <td class="col-item">
                <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/lines/${escape(l.id)}" class="inline-form" id="line-form-${escape(l.id)}">
                  ${isHybrid ? html`
                    <div class="line-section-row">
                      <label class="line-section-label">Section:</label>
                      <select name="line_type" ${readOnly ? 'disabled' : ''}
                              class="line-section-select ${!l.line_type ? 'line-section-unassigned' : ''}"
                              data-autosave>
                        <option value="" ${!l.line_type ? 'selected' : ''}>— Unassigned —</option>
                        ${quoteTypeParts.map(p => html`
                          <option value="${escape(p)}" ${l.line_type === p ? 'selected' : ''}>
                            ${escape(QUOTE_TYPE_LABELS[p] ?? p)}
                          </option>
                        `)}
                      </select>
                    </div>
                  ` : ''}
                  <div class="line-item-fields">
                    <input type="text" name="title" value="${escape(l.title ?? '')}" ${readOnly ? 'disabled' : ''}
                           placeholder="Title / Part #" class="line-title" data-autosave>
                    <input type="text" name="description" value="${escape(l.description ?? '')}" ${readOnly ? 'disabled' : ''}
                           placeholder="Description" class="line-desc" data-autosave>
                  </div>
                  <textarea name="line_notes" ${readOnly ? 'disabled' : ''}
                            placeholder="Item notes..." class="line-notes" data-autosave>${escape(l.line_notes ?? '')}</textarea>
                  ${showDiscounts ? renderLineDiscountEditor({ line: l, readOnly, hasDiscount: lineHasDiscount }) : ''}
                  <input type="hidden" name="is_option" value="${l.is_option ? '1' : '0'}">
                </form>
              </td>
              <td class="num col-qty">
                <input type="text" name="quantity" form="line-form-${escape(l.id)}" value="${escape(l.quantity ?? '')}" ${readOnly ? 'disabled' : ''} class="num-input" data-autosave>
              </td>
              <td class="col-unit">
                <input type="text" name="unit" form="line-form-${escape(l.id)}" value="${escape(l.unit ?? '')}" ${readOnly ? 'disabled' : ''} style="width: 4rem;" data-autosave>
              </td>
              <td class="num col-price">
                <input type="text" name="unit_price" form="line-form-${escape(l.id)}" value="${escape(l.unit_price ?? '')}" ${readOnly ? 'disabled' : ''} class="num-input" data-autosave>
              </td>
              <td class="num col-ext" data-line-extended>
                ${fmtDollar(l.extended_price)}
                ${l.build_quote_price != null && Math.abs(Number(l.unit_price ?? 0) - Number(l.build_quote_price)) > 0.01
                  ? html`<br><small class="muted" style="color:var(--warning)" title="Price build suggests ${fmtDollar(l.build_quote_price)}/unit">Build: ${fmtDollar(l.build_quote_price)}</small>`
                  : ''}
              </td>
              <td class="col-build">
                ${l.price_build_label
                  ? html`<a href="${pbUrl(l.id)}" class="pill ${l.price_build_status === 'locked' ? 'pill-locked' : ''}" style="font-size:0.8rem">${escape(l.build_number || l.price_build_label)}</a>`
                  : (!readOnly ? html`<a href="${pbUrl(l.id)}" class="btn small">+</a>` : html`<span class="muted">\u2014</span>`)}
                ${!readOnly ? html`
                  <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/lines/${escape(l.id)}/delete" class="inline-form" style="display:inline">
                    <button class="btn small danger" type="submit" title="Delete line">\u00d7</button>
                  </form>
                ` : ''}
              </td>
            </tr>
          `;})}
          ${!readOnly
            ? html`
              <tr class="new-line-row" data-line-row>
                <td class="col-num muted">${lines.length + 1}</td>
                <td class="col-item">
                  <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/lines" class="inline-form" id="new-line-form">
                    ${isHybrid ? html`
                      <div class="line-section-row">
                        <label class="line-section-label">Section:</label>
                        <select name="line_type" class="line-section-select line-section-unassigned">
                          <option value="">— Unassigned —</option>
                          ${quoteTypeParts.map(p => html`
                            <option value="${escape(p)}">${escape(QUOTE_TYPE_LABELS[p] ?? p)}</option>
                          `)}
                        </select>
                      </div>
                    ` : ''}
                    <div class="line-item-fields">
                      <input type="text" name="title" placeholder="Title / Part #" class="line-title">
                      <input type="text" name="description" placeholder="Description" class="line-desc">
                    </div>
                    <textarea name="line_notes" placeholder="Item notes..." class="line-notes"></textarea>
                  </form>
                </td>
                <td class="num col-qty">
                  <input type="text" name="quantity" form="new-line-form" value="1" class="num-input">
                </td>
                <td class="col-unit">
                  <input type="text" name="unit" form="new-line-form" value="ea" style="width: 4rem;">
                </td>
                <td class="num col-price">
                  <input type="text" name="unit_price" form="new-line-form" class="num-input" placeholder="0">
                </td>
                <td class="num col-ext" data-line-extended>\u2014</td>
                <td class="col-build"></td>
              </tr>
            `
            : ''}
          ${isHybrid && sectionSubtotals.length > 0 ? sectionSubtotals.map(s => html`
            <tr class="totals-row section-subtotal-row ${s.key === '_unassigned' ? 'section-unassigned' : ''}">
              <td colspan="5" class="num">
                <span class="muted" style="font-size:0.9em">${escape(s.label)} subtotal</span>
                ${s.key === '_unassigned'
                  ? html` <span class="pill" style="font-size:0.65em;background:#fef3c7;color:#92400e;border-color:#fde68a">assign a section</span>`
                  : ''}
              </td>
              <td class="num"><span class="muted">${fmtDollar(s.total)}</span></td>
              <td></td>
            </tr>
          `) : ''}
          <tr class="totals-row">
            <td colspan="5" class="num"><strong>Subtotal</strong></td>
            <td class="num" id="q-subtotal"><strong>${fmtDollar(includedSubtotal)}</strong></td>
            <td></td>
          </tr>
          ${optionSubtotal > 0 ? html`
            <tr class="totals-row">
              <td colspan="5" class="num"><em>Options (not included)</em></td>
              <td class="num"><em>${fmtDollar(optionSubtotal)}</em></td>
              <td></td>
            </tr>
          ` : ''}
          ${showDiscounts ? renderDiscountRow({ quote, readOnly, headerDiscountApplied }) : ''}
          <tr class="totals-row">
            <td colspan="5" class="num"><strong>Total</strong></td>
            <td class="num" id="q-total"><strong>${fmtDollar(total)}</strong></td>
            <td></td>
          </tr>
        </tbody>
      </table>
    </section>
  `;

  // ── 5. Footer card ─────────────────────────────────────────────────
  const footerSection = html`
    <section class="card quote-doc-card quote-doc-last">
      <label>
        <strong>Quote notes</strong>
        <textarea class="desc-textarea" placeholder="Notes to the customer"
                  ${readOnly ? 'disabled' : ''}
                  @change="window._qPatch('notes_customer', $event.target.value)">${escape(quote.notes_customer ?? '')}</textarea>
      </label>
      ${quote.quote_type === 'eps'
        ? html`
          <div x-data="epsTerms()" style="margin-top:0.75rem">
            <strong>Terms</strong>
            <textarea class="desc-textarea" data-field="payment_terms" placeholder="Payment terms, conditions..."
                      ${readOnly ? 'disabled' : ''}
                      x-model="termsVal"
                      @input="onInput()"
                      @change="onSave()"></textarea>
            <div class="terms-below-row">
              <label class="terms-default-check">
                <input type="checkbox" x-model="useDefault" ${readOnly ? 'disabled' : ''}>
                Default EPS Terms
              </label>
              <span style="font-size:0.72rem;color:var(--fg-muted);font-style:italic">
                computed from delivery weeks
              </span>
            </div>
          </div>`
        : (quote.quote_type === 'spares' || quote.quote_type === 'service')
          ? html`
            <div x-data="flatTerms()" style="margin-top:0.75rem">
              <strong>Terms</strong>
              <textarea class="desc-textarea" data-field="payment_terms" placeholder="Payment terms, conditions..."
                        ${readOnly ? 'disabled' : ''}
                        x-model="termsVal"
                        @input="onInput()"
                        @change="onSave()"></textarea>
              <div class="terms-below-row">
                <label class="terms-default-check">
                  <input type="checkbox" x-model="useDefault" ${readOnly ? 'disabled' : ''}>
                  Default ${quote.quote_type === 'spares' ? 'Spares' : 'Service'} Terms
                </label>
                ${!readOnly ? html`
                  <button type="button" class="btn-tiny"
                          @click="saveAsDefault()"
                          :disabled="saving"
                          x-text="saveLabel"
                          title="Save the current text as the default for ${quote.quote_type === 'spares' ? 'Spares' : 'Service'} quotes"></button>
                ` : ''}
              </div>
            </div>`
          : html`
            <div x-data="plainTerms('payment_terms')" style="margin-top:0.75rem">
              <strong>Terms</strong>
              <textarea class="desc-textarea" data-field="payment_terms" placeholder="Payment terms, conditions..."
                        ${readOnly ? 'disabled' : ''}
                        x-model="val"
                        @input="onInput()"
                        @change="onSave()">${escape(quote.payment_terms ?? '')}</textarea>
              ${!isHybrid ? html`
                <div class="terms-below-row">
                  <label class="terms-default-check">
                    <input type="checkbox" x-model="useDefault" ${readOnly ? 'disabled' : ''}>
                    Default ${escape(quoteTypeDisplayLabel(quote.quote_type))} Terms
                  </label>
                  ${!readOnly ? html`
                    <button type="button" class="btn-tiny"
                            @click="saveAsDefault()"
                            :disabled="saving"
                            x-text="saveLabel"
                            title="Save the current text as the default for ${escape(quoteTypeDisplayLabel(quote.quote_type))} quotes"></button>
                  ` : ''}
                </div>
              ` : ''}
            </div>`}
      <div x-data="plainTerms('delivery_terms')" style="margin-top:0.75rem">
        <strong>Delivery terms</strong>
        <textarea class="desc-textarea" placeholder="EXW, FCA, FOB, DAP..."
                  ${readOnly ? 'disabled' : ''}
                  x-model="val"
                  @input="onInput()"
                  @change="onSave()">${escape(quote.delivery_terms ?? '')}</textarea>
        ${!isHybrid ? html`
          <div class="terms-below-row">
            <label class="terms-default-check">
              <input type="checkbox" x-model="useDefault" ${readOnly ? 'disabled' : ''}>
              Default ${escape(quoteTypeDisplayLabel(quote.quote_type))} Delivery Terms
            </label>
            ${!readOnly ? html`
              <button type="button" class="btn-tiny"
                      @click="saveAsDefault()"
                      :disabled="saving"
                      x-text="saveLabel"
                      title="Save the current text as the default delivery terms for ${escape(quoteTypeDisplayLabel(quote.quote_type))} quotes"></button>
            ` : ''}
          </div>
        ` : ''}
      </div>

      ${quote.notes_internal || !readOnly ? html`
        <div style="margin-top:0.75rem;padding:0.5rem 0.7rem;background:#fff8c5;border:1px solid #d4a72c;border-radius:var(--radius)">
          <label>
            <strong style="font-size:0.85em">Internal notes (C-LARS only, not on customer quote)</strong>
            <textarea class="desc-textarea" style="background:#fffdf0"
                      ${readOnly ? 'disabled' : ''}
                      @change="window._qPatch('notes_internal', $event.target.value)">${escape(quote.notes_internal ?? '')}</textarea>
          </label>
        </div>
      ` : ''}
    </section>
  `;

  // ── Scripts ────────────────────────────────────────────────────────
  const scripts = html`
    <script>
    // Global patch helper — auto-saves quote fields via fetch.
    // Accepts either a single (field, value) pair or an object of many
    // fields. Fires the _qPatchPayload custom event on completion so
    // listeners (e.g. the totals renderer) can react to returned totals.
    window._qPatch = function(fieldOrBody, value) {
      var body;
      if (typeof fieldOrBody === 'string') {
        body = {};
        body[fieldOrBody] = value;
      } else {
        body = fieldOrBody || {};
      }
      fetch('${raw(patchUrl)}', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function(r) { return r.json(); }).then(function(d) {
        if (!d.ok) { console.error('Patch failed:', d.error); return; }
        document.dispatchEvent(new CustomEvent('_qPatchPayload', { detail: d }));
      });
    };

    // Expiration picker — mirrors the delivery picker layout: a wide
    // text input showing "N days (YYYY-MM-DD)", a days dropdown, and a
    // small calendar icon for arbitrary dates. dateVal is the canonical
    // valid_until (YYYY-MM-DD) that gets patched; textVal is the
    // human-readable string the text input shows; daysVal is the select's
    // current preset (or '' when the date doesn't match a preset).
    document.addEventListener('alpine:init', function() {
      var _expPresets = [7, 14, 21, 30, 45, 60, 90, 120];
      var _parseISODate = function(s) {
        if (!s || !/^\\d{4}-\\d{2}-\\d{2}$/.test(s)) return null;
        var d = new Date(s + 'T00:00:00Z');
        return isNaN(d.getTime()) ? null : d;
      };
      var _expComputeDays = function(dateStr) {
        var d = _parseISODate(dateStr);
        if (!d) return '';
        var t = new Date();
        t.setUTCHours(0, 0, 0, 0);
        var diff = Math.round((d.getTime() - t.getTime()) / 86400000);
        return diff >= 0 ? diff : '';
      };
      var _expFormatText = function(dateStr) {
        if (!dateStr) return '';
        var n = _expComputeDays(dateStr);
        if (n === '') return dateStr;
        return n + ' day' + (n === 1 ? '' : 's') + ' (' + dateStr + ')';
      };
      // Parse free-form user text into a canonical yyyy-mm-dd.
      // Accepts "N days", "N days (anything)", yyyy-mm-dd, and
      // US-style mm/dd/yyyy. Returns null if nothing matches.
      var _expParseInput = function(text) {
        if (!text) return '';
        var trimmed = String(text).trim();
        if (!trimmed) return '';
        var dayMatch = trimmed.match(/^(\\d+)\\s*day/i);
        if (dayMatch) {
          var d = new Date();
          d.setUTCHours(0, 0, 0, 0);
          d.setUTCDate(d.getUTCDate() + parseInt(dayMatch[1], 10));
          return d.toISOString().slice(0, 10);
        }
        if (_parseISODate(trimmed)) return trimmed;
        var usMatch = trimmed.match(/^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})$/);
        if (usMatch) {
          var mm = ('0' + usMatch[1]).slice(-2);
          var dd = ('0' + usMatch[2]).slice(-2);
          var iso = usMatch[3] + '-' + mm + '-' + dd;
          if (_parseISODate(iso)) return iso;
        }
        return null;
      };
      var _expDaysValFor = function(dateStr) {
        var n = _expComputeDays(dateStr);
        return (n !== '' && _expPresets.indexOf(Number(n)) !== -1) ? String(n) : '';
      };
      Alpine.data('expirationPicker', function(initial) {
        return {
          dateVal: initial || '',
          textVal: _expFormatText(initial || ''),
          daysVal: _expDaysValFor(initial || ''),
          setDays: function(n) {
            var d = new Date();
            d.setUTCHours(0, 0, 0, 0);
            d.setUTCDate(d.getUTCDate() + n);
            this.dateVal = d.toISOString().slice(0, 10);
            this.textVal = _expFormatText(this.dateVal);
            this.daysVal = String(n);
            this.save();
          },
          setDate: function(dateStr) {
            if (!dateStr) return;
            this.dateVal = dateStr;
            this.textVal = _expFormatText(dateStr);
            this.daysVal = _expDaysValFor(dateStr);
            this.save();
          },
          onTextChange: function() {
            var parsed = _expParseInput(this.textVal);
            if (parsed === null) {
              // Unparseable — revert to the canonical format so the
              // text input can't drift out of sync with dateVal.
              this.textVal = _expFormatText(this.dateVal);
              return;
            }
            this.dateVal = parsed;
            this.textVal = _expFormatText(parsed);
            this.daysVal = _expDaysValFor(parsed);
            this.save();
          },
          save: function() {
            window._qPatch('valid_until', this.dateVal);
          },
        };
      });

      // --- EPS default payment terms based on delivery weeks ---
      var _quoteType = ${raw(JSON.stringify(quote.quote_type || ''))};
      var _deliveryWeeks = null;
      var _initialPaymentTerms = ${raw(JSON.stringify(quote.payment_terms || ''))};
      var _initialDeliveryTerms = ${raw(JSON.stringify(quote.delivery_terms || ''))};

      // User-editable term defaults from migration 0024 — flat map of
      //   { [quoteType]: { payment_terms: '...', delivery_terms: '...' } }
      // The flatTerms / plainTerms components consult this map to
      // drive the "Default X Terms" checkbox and the "Save as default"
      // button. A click on "Save as default" updates both the DB row
      // and this local map so a second save shows "Saved" immediately.
      var _savedDefaults = ${raw(JSON.stringify(termDefaults || {}))};
      function _defaultFor(type, field) {
        return (_savedDefaults[type] && _savedDefaults[type][field]) || '';
      }

      // Parse initial delivery weeks
      var _initDeliveryMatch = (${raw(JSON.stringify(quote.delivery_estimate || ''))}).match(/^(\\d+)\\s*week/);
      if (_initDeliveryMatch) _deliveryWeeks = parseInt(_initDeliveryMatch[1], 10);

      function epsDefaultTerms(weeks) {
        if (!weeks || weeks <= 0) return '';
        var w1 = Math.floor(weeks / 3);
        var w2 = Math.floor(2 * weeks / 3);
        return '25% Due upon receipt of purchase order' + '\\n'
             + '25% Due ' + w1 + ' weeks ARO' + '\\n'
             + '25% Due ' + w2 + ' weeks ARO' + '\\n'
             + '15% Due upon completion of FAT' + '\\n'
             + '10% Due upon delivery of final documentation';
      }

      // Spares / Service payment terms come straight from the saved
      // defaults map. Empty string when nothing is saved yet — the
      // checkbox still works, it just starts off unchecked.
      function flatDefaultTerms() {
        return _defaultFor(_quoteType, 'payment_terms');
      }

      // POST to the save-as-default endpoint. Returns a Promise that
      // resolves with { ok, changed } from the server. Shared by the
      // flatTerms and plainTerms Alpine components.
      function _saveTermDefault(type, field, value) {
        return fetch('/quotes/term-defaults', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ quote_type: type, field: field, value: value }),
        }).then(function(r) { return r.json(); }).then(function(d) {
          if (d && d.ok) {
            // Mirror the saved value into our local map so a subsequent
            // load on the same page sees the new default without a
            // reload. Use the string we sent, not d.value (the endpoint
            // doesn't echo it back).
            if (!_savedDefaults[type]) _savedDefaults[type] = {};
            _savedDefaults[type][field] = value;
          }
          return d;
        });
      }

      // Delivery picker with text, calendar, and weeks dropdown.
      // weeksVal keeps the <select> showing the currently-selected week
      // count (or empty when the text is a free-form value that doesn't
      // parse to "N weeks ...").
      var _parseDeliveryWeeks = function(text) {
        var m = (text || '').match(/^(\\d+)\\s*week/);
        return m ? parseInt(m[1], 10) : '';
      };
      Alpine.data('deliveryPicker', function(initial) {
        var _initWeeks = _parseDeliveryWeeks(initial);
        return {
          textVal: initial || '',
          weeksVal: _initWeeks === '' ? '' : String(_initWeeks),
          setWeeks: function(n) {
            var d = new Date();
            d.setDate(d.getDate() + (n * 7));
            var dateStr = d.toISOString().slice(0, 10);
            this.textVal = n + ' weeks (' + dateStr + ')';
            this.weeksVal = String(n);
            this.save();
          },
          setDate: function(dateStr) {
            if (!dateStr) return;
            this.textVal = dateStr;
            this.weeksVal = '';
            this.save();
          },
          save: function() {
            window._qPatch('delivery_estimate', this.textVal);
            // Parse weeks and notify terms component. Also re-sync the
            // dropdown so it stays in step when the user types manually.
            var parsed = _parseDeliveryWeeks(this.textVal);
            _deliveryWeeks = parsed === '' ? null : parsed;
            this.weeksVal = parsed === '' ? '' : String(parsed);
            document.dispatchEvent(new CustomEvent('delivery-changed', { detail: { weeks: _deliveryWeeks } }));
          },
        };
      });

      // EPS Terms component — manages default/manual toggle
      Alpine.data('epsTerms', function() {
        return {
          termsVal: _initialPaymentTerms,
          useDefault: true,
          _skipWatch: false,
          init: function() {
            var self = this;
            // Determine initial state
            var trimmed = this.termsVal.trim();
            if (!trimmed) {
              this.useDefault = true;
              if (_deliveryWeeks) this.applyDefault();
            } else if (_deliveryWeeks && trimmed === epsDefaultTerms(_deliveryWeeks)) {
              this.useDefault = true;
            } else {
              this.useDefault = false;
            }
            // Watch checkbox changes via x-model
            this.$watch('useDefault', function(val) {
              if (self._skipWatch) return;
              if (val && _deliveryWeeks) self.applyDefault();
            });
            // Listen for delivery changes
            document.addEventListener('delivery-changed', function(e) {
              if (self.useDefault && e.detail.weeks) self.applyDefault();
            });
          },
          applyDefault: function() {
            if (!_deliveryWeeks) return;
            this.termsVal = epsDefaultTerms(_deliveryWeeks);
            window._qPatch('payment_terms', this.termsVal);
          },
          onInput: function() {
            this._skipWatch = true;
            this.useDefault = false;
            this._skipWatch = false;
          },
          onSave: function() {
            if (!this.termsVal.trim()) {
              this.useDefault = true;
              if (_deliveryWeeks) { this.applyDefault(); return; }
            }
            window._qPatch('payment_terms', this.termsVal);
          },
        };
      });

      // Spares / Service terms component — mirrors epsTerms but uses a
      // static default (no delivery-weeks dependency). The default text
      // is whatever the user last saved for this quote_type via the
      // "Save as default" button (backed by the quote_term_defaults
      // table from migration 0024).
      Alpine.data('flatTerms', function() {
        return {
          termsVal: _initialPaymentTerms,
          useDefault: true,
          saving: false,
          saveLabel: 'Save as default',
          _skipWatch: false,
          init: function() {
            var self = this;
            var trimmed = this.termsVal.trim();
            var deflt = flatDefaultTerms();
            if (!trimmed) {
              this.useDefault = true;
              if (deflt) this.applyDefault();
            } else if (deflt && trimmed === deflt) {
              this.useDefault = true;
            } else {
              this.useDefault = false;
            }
            this.$watch('useDefault', function(val) {
              if (self._skipWatch) return;
              if (val) self.applyDefault();
            });
          },
          applyDefault: function() {
            var deflt = flatDefaultTerms();
            if (!deflt) return;
            this.termsVal = deflt;
            window._qPatch('payment_terms', this.termsVal);
          },
          onInput: function() {
            this._skipWatch = true;
            this.useDefault = false;
            this._skipWatch = false;
          },
          onSave: function() {
            if (!this.termsVal.trim()) {
              this.useDefault = true;
              if (flatDefaultTerms()) { this.applyDefault(); return; }
            }
            window._qPatch('payment_terms', this.termsVal);
          },
          saveAsDefault: function() {
            var self = this;
            self.saving = true;
            self.saveLabel = 'Saving\u2026';
            _saveTermDefault(_quoteType, 'payment_terms', self.termsVal).then(function(d) {
              if (d && d.ok) {
                // Now that the saved default matches the current text,
                // the checkbox should show as "on".
                self._skipWatch = true;
                self.useDefault = true;
                self._skipWatch = false;
                self.saveLabel = d.changed ? 'Saved \u2713' : 'Already saved';
              } else {
                self.saveLabel = 'Save failed';
                console.error('Save default failed:', d && d.error);
              }
              setTimeout(function() {
                self.saving = false;
                self.saveLabel = 'Save as default';
              }, 1500);
            });
          },
        };
      });

      // Plain terms component — used for refurb_* payment-terms and
      // every non-hybrid delivery-terms textarea. Mirrors flatTerms'
      // checkbox/default machinery but parameterized by field.
      //
      // NOTE: no backticks allowed in comments inside this template
      // literal — they close the outer html tag early and break the
      // Pages build.
      //
      //   - val tracks the textarea content via x-model
      //   - useDefault is the checkbox state; flipping it on re-applies
      //     the saved default for this (quote_type, field) pair
      //   - saveAsDefault posts the current text as the new default
      //     and flips useDefault to true on success
      //
      // Initial value comes from closure scope so Alpine x-model
      // doesn't blank the textarea on mount (x-model assigns data
      // into the element on first render).
      Alpine.data('plainTerms', function(field) {
        var initial = (field === 'payment_terms')  ? _initialPaymentTerms
                    : (field === 'delivery_terms') ? _initialDeliveryTerms
                    : '';
        return {
          val: initial,
          field: field,
          useDefault: true,
          saving: false,
          saveLabel: 'Save as default',
          _skipWatch: false,
          init: function() {
            var self = this;
            var trimmed = (this.val || '').trim();
            var deflt = _defaultFor(_quoteType, this.field);
            if (!trimmed) {
              this.useDefault = true;
              if (deflt) this.applyDefault();
            } else if (deflt && trimmed === deflt) {
              this.useDefault = true;
            } else {
              this.useDefault = false;
            }
            this.$watch('useDefault', function(val) {
              if (self._skipWatch) return;
              if (val) self.applyDefault();
            });
          },
          applyDefault: function() {
            var deflt = _defaultFor(_quoteType, this.field);
            if (!deflt) return;
            this.val = deflt;
            window._qPatch(this.field, this.val);
          },
          onInput: function() {
            this._skipWatch = true;
            this.useDefault = false;
            this._skipWatch = false;
          },
          onSave: function() {
            if (!(this.val || '').trim()) {
              this.useDefault = true;
              if (_defaultFor(_quoteType, this.field)) { this.applyDefault(); return; }
            }
            window._qPatch(this.field, this.val);
          },
          saveAsDefault: function() {
            var self = this;
            self.saving = true;
            self.saveLabel = 'Saving\u2026';
            _saveTermDefault(_quoteType, self.field, self.val).then(function(d) {
              if (d && d.ok) {
                // Saved default now matches current text — reflect in
                // the checkbox (skip the watcher so we don't bounce
                // back through applyDefault).
                self._skipWatch = true;
                self.useDefault = true;
                self._skipWatch = false;
                self.saveLabel = d.changed ? 'Saved \u2713' : 'Already saved';
              } else {
                self.saveLabel = 'Save failed';
                console.error('Save default failed:', d && d.error);
              }
              setTimeout(function() {
                self.saving = false;
                self.saveLabel = 'Save as default';
              }, 1500);
            });
          },
        };
      });

      // Header-level discount component — thin wrapper around _qPatch so
      // the phantom checkbox ships a proper 0/1 int.
      Alpine.data('quoteDiscount', function() {
        return {
          patchField: function(field, value) {
            window._qPatch(field, value);
          },
          patchPhantom: function(checked) {
            window._qPatch('discount_is_phantom', checked ? 1 : 0);
          },
        };
      });

      // Per-line discount editor — the "open" flag controls the
      // collapsed/expanded state; once a discount is set on a line,
      // it is expanded on load. Inputs inside the editor use data-autosave
      // plus form="line-form-..." so the existing line autosave machinery
      // picks up changes.
      // NOTE: no backticks allowed in comments inside this template literal.
      Alpine.data('lineDiscount', function(initialOpen) {
        return {
          open: !!initialOpen,
        };
      });

      // Details card: address selector + description auto-save
      Alpine.data('quoteDetails', function() {
        return {
          editingAddr: false,
          addingNew: false,
          selectedAddrText: ${raw(JSON.stringify(defaultAddr?.address || ''))},
          addresses: ${raw(addressesJson)},
          newAddrKind: 'billing',
          newAddrLabel: '',
          newAddrText: '',
          accountId: ${raw(JSON.stringify(quote.account_id || ''))},
          init: function() {},
          selectAddress: function(val) {
            if (val === '__new__') {
              this.addingNew = true;
              return;
            }
            this.addingNew = false;
            var addr = this.addresses.find(function(a) { return a.id === val; });
            this.selectedAddrText = addr ? addr.address : '';
            this.editingAddr = false;
          },
          saveNewAddress: function() {
            var self = this;
            if (!self.newAddrText.trim()) return;
            fetch('/api/accounts/' + self.accountId + '/addresses', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                kind: self.newAddrKind,
                label: self.newAddrLabel,
                address: self.newAddrText,
              }),
            }).then(function(r) { return r.json(); }).then(function(d) {
              if (d.id) {
                self.addresses.push(d);
                self.selectedAddrText = self.newAddrText;
                self.addingNew = false;
                self.editingAddr = false;
                self.newAddrLabel = '';
                self.newAddrText = '';
              }
            });
          },
          patchField: function(field, value) {
            window._qPatch(field, value);
          },
        };
      });
    });

    // Auto-save line items on change (debounced, via fetch — no page reload)
    (function() {
      var timers = {};
      function fmtDollar(v) {
        var n = Number(v) || 0;
        return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
      }
      function updateTotals(data) {
        // Update the extended price cell for the line
        if (data.lineId) {
          var row = document.querySelector('[data-line-id="' + data.lineId + '"]');
          if (row) {
            var extCell = row.querySelector('[data-line-extended]');
            if (extCell) extCell.textContent = fmtDollar(data.extended_price);
          }
        }
        // Update subtotal and total in the table footer
        var subEl = document.getElementById('q-subtotal');
        if (subEl) subEl.innerHTML = '<strong>' + fmtDollar(data.subtotal_price) + '</strong>';
        var totalEl = document.getElementById('q-total');
        if (totalEl) totalEl.innerHTML = '<strong>' + fmtDollar(data.total_price) + '</strong>';
        var headerTotal = document.getElementById('q-header-total');
        if (headerTotal) headerTotal.textContent = fmtDollar(data.total_price);
        // If the line-save payload includes discount_applied, update the
        // discount cell too (a line change that affects subtotal affects
        // the %-based header discount proportionally).
        if (typeof data.discount_applied === 'number') {
          var discEl = document.getElementById('q-discount-applied');
          if (discEl) {
            var amt = Number(data.discount_applied || 0);
            discEl.innerHTML = '<em>' + (amt > 0 ? '-' + fmtDollar(amt) : '') + '</em>';
          }
        }
      }

      // Listen for _qPatch responses that include recomputed totals (e.g.
      // from discount or tax_amount changes) and update the visible figures.
      document.addEventListener('_qPatchPayload', function(e) {
        var d = (e.detail || {});
        if (d.totals) {
          updateTotals({
            subtotal_price: d.totals.subtotal_price,
            total_price: d.totals.total_price,
          });
          var discEl = document.getElementById('q-discount-applied');
          if (discEl) {
            var amt = Number(d.totals.discount_applied || 0);
            discEl.innerHTML = '<em>' + (amt > 0 ? '-' + fmtDollar(amt) : '') + '</em>';
          }
        }
      });
      function saveForm(form) {
        var formData = new FormData(form);
        fetch(form.action, {
          method: 'POST',
          headers: { 'accept': 'application/json' },
          body: formData,
        }).then(function(r) { return r.json(); })
          .then(function(data) {
            if (!data.ok) { console.error('Line save failed:', data); return; }
            updateTotals(data);
            // If a new line was created, reload to show it as a proper row
            if (data.isNew) {
              var scrollY = window.scrollY;
              sessionStorage.setItem('_scrollY', scrollY);
              window.location.reload();
            }
          })
          .catch(function(err) { console.error('Line save error:', err); });
      }
      document.querySelectorAll('[data-autosave]').forEach(function(input) {
        input.addEventListener('change', function() {
          var form = input.form || document.getElementById(input.getAttribute('form'));
          if (!form) return;
          var formId = form.id;
          if (timers[formId]) clearTimeout(timers[formId]);
          timers[formId] = setTimeout(function() { saveForm(form); }, 800);
        });
      });
      var newForm = document.getElementById('new-line-form');
      if (newForm) {
        var titleInput = newForm.querySelector('[name="title"]');
        if (titleInput) {
          titleInput.addEventListener('change', function() {
            if (titleInput.value.trim()) saveForm(newForm);
          });
        }
      }
      // Restore scroll position after new-line reload
      var savedY = sessionStorage.getItem('_scrollY');
      if (savedY) {
        sessionStorage.removeItem('_scrollY');
        window.scrollTo(0, parseInt(savedY, 10));
      }
    })();
    </script>
  `;

  const body = html`${headerSection}<div class="quote-doc">${bannerCard}${detailsSection}${linesSection}${footerSection}</div>${scripts}`;

  return htmlResponse(
    layout(
      `${quote.number} Rev ${quote.revision} — ${quote.title || ''}`,
      body,
      {
        user,
        env: data?.env,
        activeNav: '/opportunities',
        flash,
        breadcrumbs: [
          { label: 'Opportunities', href: '/opportunities' },
          { label: `${quote.opp_number} — ${quote.opp_title || ''}`, href: `/opportunities/${oppId}` },
          { label: `${quote.number} Rev ${quote.revision}` },
        ],
      }
    )
  );
}

// Keep the POST handler as fallback for the form-based line item saves
// and for any non-JS clients.
export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const oppId = params.id;
  const quoteId = params.quoteId;

  const before = await one(
    env.DB,
    'SELECT * FROM quotes WHERE id = ?',
    [quoteId]
  );
  if (!before || before.opportunity_id !== oppId) {
    return new Response('Quote not found', { status: 404 });
  }
  if (READ_ONLY_STATUSES.has(before.status)) {
    return redirectWithFlash(
      `/opportunities/${oppId}/quotes/${quoteId}`,
      `Cannot edit a ${before.status} quote. Create a new revision.`,
      'error'
    );
  }

  const opp = await one(env.DB, 'SELECT transaction_type FROM opportunities WHERE id = ?', [oppId]);

  const input = await formBody(request);
  const { ok, value, errors } = validateQuote(input, {
    transactionType: opp?.transaction_type,
    requireType: false,
  });
  if (!ok) {
    const firstErr = Object.values(errors)[0] ?? 'Invalid input.';
    return redirectWithFlash(
      `/opportunities/${oppId}/quotes/${quoteId}`,
      firstErr,
      'error'
    );
  }

  if (!value.quote_type) value.quote_type = before.quote_type;

  const ts = now();
  const after = { ...before, ...value };
  const changes = diff(before, after, UPDATE_FIELDS);

  await batch(env.DB, [
    stmt(
      env.DB,
      `UPDATE quotes
          SET quote_type = ?,
              title = ?,
              description = ?,
              valid_until = ?,
              incoterms = ?,
              payment_terms = ?,
              delivery_terms = ?,
              delivery_estimate = ?,
              tax_amount = ?,
              notes_internal = ?,
              notes_customer = ?,
              updated_at = ?
        WHERE id = ?`,
      [
        value.quote_type, value.title, value.description, value.valid_until,
        value.incoterms, value.payment_terms, value.delivery_terms,
        value.delivery_estimate, value.tax_amount,
        value.notes_internal, value.notes_customer, ts, quoteId,
      ]
    ),
    // Always recompute totals — tax_amount may have changed, and the
    // shared helper pulls the up-to-date discount fields out of the row.
    quoteTotalsRecomputeStmt(env.DB, quoteId, ts),
    auditStmt(env.DB, {
      entityType: 'quote',
      entityId: quoteId,
      eventType: 'updated',
      user,
      summary: `Updated ${before.number} Rev ${before.revision}`,
      changes,
    }),
  ]);

  return redirectWithFlash(
    `/opportunities/${oppId}/quotes/${quoteId}`,
    'Saved.'
  );
}

// --- helpers ---------------------------------------------------------------

function statusPillClass(status) {
  switch (status) {
    case 'draft':            return '';
    case 'revision_draft':   return '';
    case 'issued':           return 'pill-success';
    case 'revision_issued':  return 'pill-success';
    case 'accepted':         return 'pill-success';
    case 'rejected':         return 'pill-locked';
    case 'expired':          return 'pill-locked';
    case 'dead':             return 'pill-locked';
    default:                 return '';
  }
}

function formatTimestamp(iso) {
  if (!iso) return '';
  return String(iso).replace('T', ' ').replace(/\.\d+Z?$/, '').slice(0, 16);
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Render the discount rows inside the line-items table totals section.
 * Always rendered so editors can toggle a discount on an existing quote
 * even when none was set before. Collapses to a single "Add discount"
 * affordance row when no discount is set and the quote is editable; when
 * the quote is read-only and has no discount, returns nothing.
 */
function renderDiscountRow({ quote, readOnly, headerDiscountApplied }) {
  const hasDiscount =
    quote.discount_amount != null ||
    quote.discount_pct != null ||
    (quote.discount_description && quote.discount_description.trim() !== '') ||
    quote.discount_is_phantom === 1;

  if (readOnly && !hasDiscount) return '';

  const amtVal = quote.discount_amount != null ? quote.discount_amount : '';
  const pctVal = quote.discount_pct != null ? quote.discount_pct : '';
  const descVal = quote.discount_description ?? '';
  const phantomChecked = quote.discount_is_phantom === 1 ? 'checked' : '';

  // Read-only rendering (issued/accepted/etc): just show the discount line.
  if (readOnly) {
    return html`
      <tr class="totals-row discount-row">
        <td colspan="5" class="num"><em>${escape(descVal || 'Discount')}</em></td>
        <td class="num"><em>-${fmtDollar(headerDiscountApplied)}</em></td>
        <td></td>
      </tr>
    `;
  }

  // Editable rendering: inline inputs for description / amount / pct / phantom.
  return html`
    <tr class="totals-row discount-row" x-data="quoteDiscount()">
      <td colspan="5" class="num" style="text-align:right">
        <div class="discount-editor" style="display:inline-flex;gap:0.5rem;align-items:center;flex-wrap:wrap;justify-content:flex-end">
          <label class="muted" style="font-size:0.85em">
            <input type="checkbox" name="discount_is_phantom"
                   ${phantomChecked}
                   @change="patchPhantom($event.target.checked)"
                   title="When checked, unit prices on the PDF are marked up to show a 'list price' with a matching discount line — the revenue figure doesn't change.">
            Phantom
          </label>
          <input type="text" placeholder="Discount description"
                 value="${escape(descVal)}"
                 @change="patchField('discount_description', $event.target.value)"
                 style="width:16rem">
          <span class="muted" style="font-size:0.85em">$</span>
          <input type="text" placeholder="Amount"
                 value="${escape(String(amtVal))}"
                 @change="patchField('discount_amount', $event.target.value)"
                 class="num-input" style="width:5rem">
          <span class="muted" style="font-size:0.85em">or</span>
          <input type="text" placeholder="%"
                 value="${escape(String(pctVal))}"
                 @change="patchField('discount_pct', $event.target.value)"
                 class="num-input" style="width:3.5rem">
          <span class="muted" style="font-size:0.85em">%</span>
        </div>
      </td>
      <td class="num" id="q-discount-applied">
        <em>${headerDiscountApplied > 0 ? html`-${fmtDollar(headerDiscountApplied)}` : ''}</em>
      </td>
      <td></td>
    </tr>
  `;
}

/**
 * Render the per-line discount editor inside the item cell, below the
 * line_notes textarea. Uses the same form as the rest of the line so the
 * existing data-autosave mechanism catches changes automatically.
 *
 * Collapsed to a "+ Add discount" affordance when no discount is set and
 * the quote is editable. Expanded (showing all fields) when a discount is
 * set or the user clicks the affordance. Hidden entirely when read-only
 * and no discount is set.
 */
function renderLineDiscountEditor({ line, readOnly, hasDiscount }) {
  if (readOnly && !hasDiscount) return '';

  const id = line.id;
  const descVal = line.discount_description ?? '';
  const amtVal = line.discount_amount != null ? line.discount_amount : '';
  const pctVal = line.discount_pct != null ? line.discount_pct : '';
  const phantomChecked = line.discount_is_phantom === 1 ? 'checked' : '';

  if (readOnly) {
    // Read-only display — show the discount as a small muted line under
    // line_notes. The math itself lives in extended_price already.
    const bits = [];
    if (descVal) bits.push(escape(descVal));
    if (line.discount_amount) bits.push(`-${fmtDollar(line.discount_amount)}`);
    if (line.discount_pct) bits.push(`-${line.discount_pct}%`);
    if (line.discount_is_phantom === 1) bits.push('(phantom)');
    return html`
      <div class="line-discount-ro muted" style="font-size:0.8em;margin-top:0.2rem">
        Discount: ${raw(bits.join(' · '))}
      </div>
    `;
  }

  return html`
    <div x-data="lineDiscount(${hasDiscount ? 'true' : 'false'})"
         class="line-discount-editor"
         style="margin-top:0.3rem;font-size:0.85em">
      <a x-show="!open" @click="open = true" class="muted"
         style="cursor:pointer;text-decoration:underline">+ Add discount</a>
      <div x-show="open" x-cloak
           style="display:flex;gap:0.4rem;align-items:center;flex-wrap:wrap">
        <span class="muted">Discount:</span>
        <input type="text" name="discount_description"
               form="line-form-${escape(id)}"
               value="${escape(descVal)}"
               placeholder="description"
               data-autosave
               style="flex:1;min-width:6rem;font-size:0.85em">
        <span class="muted">$</span>
        <input type="text" name="discount_amount"
               form="line-form-${escape(id)}"
               value="${escape(String(amtVal))}"
               placeholder="0"
               data-autosave
               class="num-input" style="width:4rem;font-size:0.85em">
        <span class="muted">or</span>
        <input type="text" name="discount_pct"
               form="line-form-${escape(id)}"
               value="${escape(String(pctVal))}"
               placeholder="0"
               data-autosave
               class="num-input" style="width:3rem;font-size:0.85em">
        <span class="muted">%</span>
        <label class="muted" style="display:inline-flex;align-items:center;gap:0.2rem;cursor:pointer"
               title="When checked, unit price on the PDF is marked up to show a 'list price' with a matching discount line — the revenue figure doesn't change.">
          <input type="checkbox" name="discount_is_phantom" value="1"
                 form="line-form-${escape(id)}"
                 ${phantomChecked}
                 data-autosave>
          Phantom
        </label>
      </div>
    </div>
  `;
}

function notFound(context) {
  const { data } = context;
  return htmlResponse(
    layout(
      'Quote not found',
      `<section class="card">
        <h1>Quote not found</h1>
        <p><a href="/opportunities">Back to opportunities</a></p>
      </section>`,
      { user: data?.user, env: data?.env, activeNav: '/opportunities' }
    ),
    { status: 404 }
  );
}
