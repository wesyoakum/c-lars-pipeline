// functions/opportunities/[id]/quotes/[quoteId]/index.js
//
// GET  /opportunities/:id/quotes/:quoteId  — quote detail / editor
// POST /opportunities/:id/quotes/:quoteId  — update header fields
//
// Layout mirrors the C-LARS Word quotation template:
//   1. Header card — quote number, status pill, transition actions,
//      revision strip, governance snapshot (all in one card)
//   2. Two-column grid — client info (left) + quote metadata (right)
//   3. Line items table with price build links
//
// Status transitions (submit, revise, accept, reject, supersede,
// expire) live in sibling files.
//
// Quotes in a terminal status (accepted, rejected, expired, dead)
// are read-only — the header form and line routes refuse updates.

import { one, all, stmt, batch } from '../../../../lib/db.js';
import { auditStmt, diff } from '../../../../lib/audit.js';
import { now } from '../../../../lib/ids.js';
import { layout, htmlResponse, html, raw, escape } from '../../../../lib/layout.js';
import { redirectWithFlash, formBody, readFlash } from '../../../../lib/http.js';
import {
  validateQuote,
  allowedQuoteTypes,
  QUOTE_TYPE_LABELS,
  QUOTE_STATUS_LABELS,
} from '../../../../lib/validators.js';
import { fmtDollar } from '../../../../lib/pricing.js';

const READ_ONLY_STATUSES = new Set([
  'issued',
  'revision_issued',
  'accepted',
  'rejected',
  'expired',
  'dead',
]);

const UPDATE_FIELDS = [
  'quote_type',
  'title',
  'description',
  'valid_until',
  'incoterms',
  'payment_terms',
  'delivery_terms',
  'delivery_estimate',
  'tax_amount',
  'notes_internal',
  'notes_customer',
];

export async function onRequestGet(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const oppId = params.id;
  const quoteId = params.quoteId;

  const quote = await one(
    env.DB,
    `SELECT q.*, o.number AS opp_number, o.title AS opp_title,
            o.transaction_type AS opp_transaction_type,
            o.account_id,
            a.name AS account_name, a.phone AS account_phone,
            a.address_billing AS account_address,
            c.first_name AS contact_first, c.last_name AS contact_last,
            c.email AS contact_email, c.phone AS contact_phone, c.title AS contact_title,
            sup.number AS supersedes_number, sup.revision AS supersedes_revision,
            cb.label AS cost_build_label, cb.status AS cost_build_status,
            subu.display_name AS submitted_by_name, subu.email AS submitted_by_email
       FROM quotes q
       LEFT JOIN opportunities o ON o.id = q.opportunity_id
       LEFT JOIN accounts a      ON a.id = o.account_id
       LEFT JOIN contacts c      ON c.id = o.primary_contact_id
       LEFT JOIN quotes sup      ON sup.id = q.supersedes_quote_id
       LEFT JOIN cost_builds cb  ON cb.id = q.cost_build_id
       LEFT JOIN users subu      ON subu.id = q.submitted_by_user_id
      WHERE q.id = ?`,
    [quoteId]
  );
  if (!quote || quote.opportunity_id !== oppId) return notFound(context);

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

  const libraryItems = await all(
    env.DB,
    `SELECT id, name, default_unit, default_price FROM items_library WHERE active = 1 ORDER BY name`
  );

  const revisionHistory = await all(
    env.DB,
    `SELECT id, number, revision, status, created_at
       FROM quotes
      WHERE opportunity_id = ? AND quote_seq = ?
      ORDER BY created_at`,
    [oppId, quote.quote_seq]
  );

  const readOnly = READ_ONLY_STATUSES.has(quote.status);

  const subtotal = lines.reduce((a, l) => a + Number(l.extended_price ?? 0), 0);
  const total = subtotal + Number(quote.tax_amount ?? 0);

  const flash = readFlash(url);

  const isDraft = quote.status === 'draft' || quote.status === 'revision_draft';
  const isIssued = quote.status === 'issued' || quote.status === 'revision_issued';

  // Allowed quote types for the transaction type (for type selector)
  const typeOptions = allowedQuoteTypes(quote.opp_transaction_type);

  // --- Header card (title, status, actions, revisions, governance) ---------
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
            ${escape(QUOTE_TYPE_LABELS[quote.quote_type] ?? quote.quote_type)}
            · ${escape(quote.revision)}
            ${quote.title ? html` · ${escape(quote.title)}` : ''}
            ${quote.supersedes_quote_id
              ? html` · supersedes <a href="/opportunities/${escape(oppId)}/quotes/${escape(quote.supersedes_quote_id)}">${escape(quote.supersedes_number ?? '')} ${escape(quote.supersedes_revision ?? '')}</a>`
              : ''}
          </p>
        </div>
        <div class="header-actions">
          ${isDraft ? html`
            <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/submit" class="inline-form">
              <button class="btn primary" type="submit">Issue</button>
            </form>
          ` : ''}
          ${isIssued ? html`
            <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/accept" class="inline-form">
              <button class="btn primary" type="submit">Accept</button>
            </form>
            <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/reject" class="inline-form">
              <button class="btn" type="submit">Reject</button>
            </form>
            <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/expire" class="inline-form">
              <button class="btn" type="submit">Expire</button>
            </form>
          ` : ''}
          ${isDraft || isIssued ? html`
            <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/revise" class="inline-form">
              <button class="btn" type="submit">Revise</button>
            </form>
          ` : ''}
          ${quote.status === 'accepted' || quote.status === 'rejected' || quote.status === 'expired' ? html`
            <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/revise" class="inline-form">
              <button class="btn primary" type="submit">New revision</button>
            </form>
          ` : ''}
          ${isDraft || isIssued ? html`
            <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/delete"
                  class="inline-form"
                  onsubmit="return confirm('Delete this quote? This cannot be undone.');">
              <button class="btn danger" type="submit">Delete</button>
            </form>
          ` : ''}
          <a class="btn btn-sm" href="/opportunities/${escape(oppId)}?tab=quotes">Back</a>
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
            <p class="muted" style="margin:0 0 0.25rem">
              Issued ${escape(formatTimestamp(quote.submitted_at))}
              by ${escape(quote.submitted_by_name ?? quote.submitted_by_email ?? 'unknown')}
              · T&amp;Cs ${escape(quote.tc_revision ?? '—')}
              · Warranty ${escape(quote.warranty_revision ?? '—')}
              · Rate Sched ${escape(quote.rate_schedule_revision ?? '—')}
              · SOP ${escape(quote.sop_revision ?? '—')}
            </p>
          </div>`
        : ''}
    </section>
  `;

  // --- Client + quote details (two-column grid) ---------------------------
  const contactName = [quote.contact_first, quote.contact_last].filter(Boolean).join(' ');

  const detailsSection = html`
    <section class="card">
      ${readOnly
        ? html`<p class="muted" style="margin:0 0 0.5rem"><em>This quote is ${escape(quote.status)}. Create a new revision to make changes.</em></p>`
        : ''}
      <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}" class="stack-form" id="quote-form">
        <fieldset ${readOnly ? 'disabled' : ''}>
          <div class="quote-meta-grid">
            <div class="quote-meta-left">
              <h3 style="margin:0 0 0.5rem">Client</h3>
              <div class="client-info">
                ${quote.account_name
                  ? html`<p style="margin:0"><strong><a href="/accounts/${escape(quote.account_id)}">${escape(quote.account_name)}</a></strong></p>`
                  : html`<p class="muted" style="margin:0">No account linked</p>`}
                ${contactName
                  ? html`<p style="margin:0">${escape(contactName)}${quote.contact_title ? html`, ${escape(quote.contact_title)}` : ''}</p>`
                  : ''}
                ${quote.contact_email
                  ? html`<p style="margin:0"><a href="mailto:${escape(quote.contact_email)}">${escape(quote.contact_email)}</a></p>`
                  : ''}
                ${quote.contact_phone
                  ? html`<p style="margin:0">${escape(quote.contact_phone)}</p>`
                  : ''}
                ${quote.account_address
                  ? html`<p style="margin:0.25rem 0 0" class="muted">${escape(quote.account_address)}</p>`
                  : ''}
              </div>
            </div>
            <div class="quote-meta-right">
              <div class="form-grid form-grid-2">
                ${typeOptions.length > 1 ? html`
                  <label>
                    Quote type
                    <select name="quote_type">
                      ${typeOptions.map(t => html`
                        <option value="${escape(t)}" ${quote.quote_type === t ? 'selected' : ''}>
                          ${escape(QUOTE_TYPE_LABELS[t] ?? t)}
                        </option>
                      `)}
                    </select>
                  </label>
                ` : html`
                  <input type="hidden" name="quote_type" value="${escape(quote.quote_type)}">
                `}
                <label>
                  Title
                  <input type="text" name="title" value="${escape(quote.title ?? '')}" placeholder="Short descriptor">
                </label>
                <label>
                  Valid until
                  <input type="date" name="valid_until" value="${escape(quote.valid_until ?? '')}">
                </label>
                <label>
                  Payment terms
                  <input type="text" name="payment_terms" value="${escape(quote.payment_terms ?? '')}" placeholder="Net 30 / 50% down / ..."
                         list="payment-terms-list">
                  <datalist id="payment-terms-list">
                    <option value="Net 30">
                    <option value="Net 60">
                    <option value="Net 90">
                    <option value="50% down, 50% on delivery">
                    <option value="COD (Cash on Delivery)">
                    <option value="CIA (Cash in Advance)">
                    <option value="Progress payments per milestone">
                  </datalist>
                </label>
                <label>
                  Delivery terms
                  <input type="text" name="delivery_terms" value="${escape(quote.delivery_terms ?? '')}"
                         placeholder="EXW / FCA / DAP / ..."
                         list="delivery-terms-list">
                  <datalist id="delivery-terms-list">
                    <option value="EXW — Ex Works">
                    <option value="FCA — Free Carrier">
                    <option value="FOB — Free on Board">
                    <option value="CIF — Cost, Insurance & Freight">
                    <option value="DAP — Delivered at Place">
                    <option value="DDP — Delivered Duty Paid">
                    <option value="Customer Pickup">
                  </datalist>
                </label>
                <label>
                  Lead time
                  <input type="text" name="delivery_estimate" value="${escape(quote.delivery_estimate ?? '')}" placeholder="14-16 weeks ARO">
                </label>
              </div>
            </div>
          </div>

          <label>
            Description
            <textarea name="description" rows="2" placeholder="Scope description for the customer">${escape(quote.description ?? '')}</textarea>
          </label>

          <input type="hidden" name="tax_amount" value="${quote.tax_amount != null ? escape(Number(quote.tax_amount).toFixed(2)) : '0'}">
          <input type="hidden" name="incoterms" value="${escape(quote.incoterms ?? '')}">

          <div class="form-grid form-grid-2">
            <label>
              Internal notes <span class="muted">(C-LARS only)</span>
              <textarea name="notes_internal" rows="2">${escape(quote.notes_internal ?? '')}</textarea>
            </label>
            <label>
              Customer notes
              <textarea name="notes_customer" rows="2">${escape(quote.notes_customer ?? '')}</textarea>
            </label>
          </div>
        </fieldset>

        ${!readOnly
          ? html`<div class="form-actions"><button type="submit" class="btn primary">Save quote</button></div>`
          : ''}
      </form>
    </section>
  `;

  // --- Lines section -------------------------------------------------------
  const pbUrl = (lineId) => `/opportunities/${oppId}/quotes/${quoteId}/lines/${lineId}/price-build`;

  const optionSubtotal = lines.filter(l => l.is_option).reduce((a, l) => a + Number(l.extended_price ?? 0), 0);
  const includedSubtotal = subtotal - optionSubtotal;

  const linesSection = html`
    <section class="card">
      <div class="card-header">
        <h2>Line items</h2>
        <div class="header-actions">
          <span class="header-value" id="q-lines-subtotal">${fmtDollar(includedSubtotal)} subtotal</span>
        </div>
      </div>

      <table class="data compact" data-live-calc="quote-lines" id="quote-lines-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Title / Part #</th>
            <th>Description</th>
            <th class="num">Qty</th>
            <th>Unit</th>
            <th class="num">Unit price</th>
            <th class="num">Extended</th>
            <th>Build</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${lines.map((l, i) => html`
            <tr data-line-row data-line-id="${escape(l.id)}" class="${l.is_option ? 'line-option' : ''}">
              <td>${i + 1}${l.is_option ? html`<br><span class="pill" style="font-size:0.7em">OPT</span>` : ''}</td>
              <td>
                <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/lines/${escape(l.id)}" class="inline-form" id="line-form-${escape(l.id)}">
                  <input type="text" name="title" value="${escape(l.title ?? '')}" ${readOnly ? 'disabled' : ''}
                         placeholder="Title / Part #" style="width: 100%;" data-autosave>
                  <input type="hidden" name="is_option" value="${l.is_option ? '1' : '0'}">
                </form>
              </td>
              <td>
                <input type="text" name="description" form="line-form-${escape(l.id)}" value="${escape(l.description ?? '')}" ${readOnly ? 'disabled' : ''} style="width: 100%;" data-autosave>
              </td>
              <td class="num">
                <input type="text" name="quantity" form="line-form-${escape(l.id)}" value="${escape(l.quantity ?? '')}" ${readOnly ? 'disabled' : ''} class="num-input" data-autosave>
              </td>
              <td>
                <input type="text" name="unit" form="line-form-${escape(l.id)}" value="${escape(l.unit ?? '')}" ${readOnly ? 'disabled' : ''} style="width: 4rem;" data-autosave>
              </td>
              <td class="num">
                <input type="text" name="unit_price" form="line-form-${escape(l.id)}" value="${escape(l.unit_price ?? '')}" ${readOnly ? 'disabled' : ''} class="num-input" data-autosave>
              </td>
              <td class="num" data-line-extended>
                ${fmtDollar(l.extended_price)}
                ${l.build_quote_price != null && Math.abs(Number(l.unit_price ?? 0) - Number(l.build_quote_price)) > 0.01
                  ? html`<br><small class="muted" style="color:var(--warning)" title="Price build suggests ${fmtDollar(l.build_quote_price)}/unit">Build: ${fmtDollar(l.build_quote_price)}</small>`
                  : ''}
              </td>
              <td>
                ${l.price_build_label
                  ? html`<a href="${pbUrl(l.id)}" class="pill ${l.price_build_status === 'locked' ? 'pill-locked' : ''}" style="font-size:0.8rem">${escape(l.build_number || l.price_build_label)}</a>`
                  : (!readOnly ? html`<a href="${pbUrl(l.id)}" class="btn small">+ Build</a>` : html`<span class="muted">\u2014</span>`)}
              </td>
              <td class="row-actions">
                ${!readOnly ? html`
                  <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/lines/${escape(l.id)}/delete" class="inline-form">
                    <button class="btn small danger" type="submit" title="Delete line">\u00d7</button>
                  </form>
                ` : ''}
              </td>
            </tr>
          `)}
          ${!readOnly
            ? html`
              <tr class="new-line-row" data-line-row>
                <td class="muted">${lines.length + 1}</td>
                <td>
                  <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/lines" class="inline-form" id="new-line-form">
                    <input type="text" name="title" placeholder="Title / Part #" style="width: 100%;">
                  </form>
                </td>
                <td>
                  <input type="text" name="description" form="new-line-form" placeholder="Description" style="width: 100%;">
                </td>
                <td class="num">
                  <input type="text" name="quantity" form="new-line-form" value="1" class="num-input">
                </td>
                <td>
                  <input type="text" name="unit" form="new-line-form" value="ea" style="width: 4rem;">
                </td>
                <td class="num">
                  <input type="text" name="unit_price" form="new-line-form" class="num-input" placeholder="0">
                </td>
                <td class="num" data-line-extended>\u2014</td>
                <td></td>
                <td></td>
              </tr>
            `
            : ''}
          <tr class="totals-row">
            <td colspan="6" class="num"><strong>Subtotal</strong></td>
            <td class="num" id="q-subtotal"><strong>${fmtDollar(includedSubtotal)}</strong></td>
            <td colspan="2"></td>
          </tr>
          ${optionSubtotal > 0 ? html`
            <tr class="totals-row">
              <td colspan="6" class="num"><em>Options (not included)</em></td>
              <td class="num"><em>${fmtDollar(optionSubtotal)}</em></td>
              <td colspan="2"></td>
            </tr>
          ` : ''}
          <tr class="totals-row">
            <td colspan="6" class="num"><strong>Total</strong></td>
            <td class="num" id="q-total"><strong>${fmtDollar(total)}</strong></td>
            <td colspan="2"></td>
          </tr>
        </tbody>
      </table>
    </section>

    ${!readOnly ? html`
      <script>
      (function() {
        var timers = {};
        document.querySelectorAll('[data-autosave]').forEach(function(input) {
          input.addEventListener('change', function() {
            var form = input.form || document.getElementById(input.getAttribute('form'));
            if (!form) return;
            var formId = form.id;
            if (timers[formId]) clearTimeout(timers[formId]);
            timers[formId] = setTimeout(function() {
              form.requestSubmit();
            }, 800);
          });
        });
        var newForm = document.getElementById('new-line-form');
        if (newForm) {
          var descInput = newForm.querySelector('[name="description"]');
          var titleInput = newForm.querySelector('[name="title"]');
          var target = descInput || titleInput;
          if (target) {
            target.addEventListener('change', function() {
              if (target.value.trim()) newForm.requestSubmit();
            });
          }
        }
      })();
      </script>
    ` : ''}
  `;

  const body = html`${headerSection}${detailsSection}${linesSection}`;

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

  // If quote_type wasn't in the form (single-type transaction), keep existing
  if (!value.quote_type) value.quote_type = before.quote_type;

  const ts = now();
  const after = { ...before, ...value };
  const changes = diff(before, after, UPDATE_FIELDS);

  const lineTotals = await one(
    env.DB,
    `SELECT COALESCE(SUM(extended_price), 0) AS subtotal FROM quote_lines WHERE quote_id = ?`,
    [quoteId]
  );
  const subtotal = Number(lineTotals?.subtotal ?? 0);
  const total = subtotal + Number(value.tax_amount ?? 0);

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
              subtotal_price = ?,
              total_price = ?,
              notes_internal = ?,
              notes_customer = ?,
              updated_at = ?
        WHERE id = ?`,
      [
        value.quote_type,
        value.title,
        value.description,
        value.valid_until,
        value.incoterms,
        value.payment_terms,
        value.delivery_terms,
        value.delivery_estimate,
        value.tax_amount,
        subtotal,
        total,
        value.notes_internal,
        value.notes_customer,
        ts,
        quoteId,
      ]
    ),
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
