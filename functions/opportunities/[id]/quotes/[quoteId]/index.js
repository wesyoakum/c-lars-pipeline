// functions/opportunities/[id]/quotes/[quoteId]/index.js
//
// GET  /opportunities/:id/quotes/:quoteId  — quote detail / editor
// POST /opportunities/:id/quotes/:quoteId  — update header fields
//
// Layout mirrors the C-LARS Word quotation template:
//   1. Header card — quote number, status pill, total, transition actions,
//      revision strip, governance snapshot
//   2. Banner card — "QUOTATION" + quote type left, C-LARS logo right
//   3. Details card — account/address left, quote meta right, description
//   4. Line items card — item table with notes row per line
//   5. Footer card — customer notes, terms
//
// Status transitions live in sibling files.
// Quotes in a terminal status are read-only.

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

  // Primary billing address from account_addresses
  const primaryAddr = quote.account_id
    ? await one(
        env.DB,
        `SELECT address FROM account_addresses
          WHERE account_id = ? AND kind = 'billing' AND is_default = 1
          LIMIT 1`,
        [quote.account_id]
      )
    : null;

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

  const readOnly = READ_ONLY_STATUSES.has(quote.status);

  const subtotal = lines.reduce((a, l) => a + Number(l.extended_price ?? 0), 0);
  const total = subtotal + Number(quote.tax_amount ?? 0);

  const flash = readFlash(url);

  const isDraft = quote.status === 'draft' || quote.status === 'revision_draft';
  const isIssued = quote.status === 'issued' || quote.status === 'revision_issued';
  const typeOptions = allowedQuoteTypes(quote.opp_transaction_type);

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
    </section>
  `;

  // ── 2. Banner card ─────────────────────────────────────────────────
  const bannerCard = html`
    <section class="card quote-banner">
      <div class="quote-banner-inner">
        <div>
          <h2 class="quote-banner-title">QUOTATION</h2>
          <p class="quote-banner-type">${escape(QUOTE_TYPE_LABELS[quote.quote_type] ?? quote.quote_type)}</p>
        </div>
        <img src="/img/logo-black.png" alt="C-LARS" class="quote-banner-logo">
      </div>
    </section>
  `;

  // ── 3. Details card ────────────────────────────────────────────────
  const contactName = [quote.contact_first, quote.contact_last].filter(Boolean).join(' ');
  const addressText = primaryAddr?.address ?? '';

  const detailsSection = html`
    <section class="card">
      ${readOnly
        ? html`<p class="muted" style="margin:0 0 0.5rem"><em>This quote is ${escape(quote.status)}. Create a new revision to make changes.</em></p>`
        : ''}
      <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}" class="stack-form" id="quote-form">
        <fieldset ${readOnly ? 'disabled' : ''}>
          <div class="quote-meta-grid">
            <div class="quote-meta-left">
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
                ${addressText
                  ? html`<pre class="addr" style="margin:0.4rem 0 0">${escape(addressText)}</pre>`
                  : ''}
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
                    <input type="date" name="valid_until" value="${escape(quote.valid_until ?? '')}" class="meta-input">
                  </td>
                </tr>
                <tr>
                  <td class="meta-label">Delivery:</td>
                  <td>
                    <input type="text" name="delivery_estimate" value="${escape(quote.delivery_estimate ?? '')}" placeholder="14-16 weeks ARO" class="meta-input">
                  </td>
                </tr>
              </table>
            </div>
          </div>

          <label class="desc-label">
            Description
            <textarea name="description" placeholder="Scope description for the customer" class="desc-textarea">${escape(quote.description ?? '')}</textarea>
          </label>

          ${typeOptions.length > 1 ? html`
            <input type="hidden" name="quote_type" value="${escape(quote.quote_type)}">
          ` : html`
            <input type="hidden" name="quote_type" value="${escape(quote.quote_type)}">
          `}
          <input type="hidden" name="title" value="${escape(quote.title ?? '')}">
          <input type="hidden" name="tax_amount" value="${quote.tax_amount != null ? escape(Number(quote.tax_amount).toFixed(2)) : '0'}">
          <input type="hidden" name="incoterms" value="${escape(quote.incoterms ?? '')}">
          <input type="hidden" name="payment_terms" value="${escape(quote.payment_terms ?? '')}">
          <input type="hidden" name="delivery_terms" value="${escape(quote.delivery_terms ?? '')}">
          <input type="hidden" name="notes_internal" value="${escape(quote.notes_internal ?? '')}">
          <input type="hidden" name="notes_customer" value="${escape(quote.notes_customer ?? '')}">
        </fieldset>

        ${!readOnly
          ? html`<div class="form-actions"><button type="submit" class="btn primary">Save quote</button></div>`
          : ''}
      </form>
    </section>
  `;

  // ── 4. Line items card ─────────────────────────────────────────────
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
          ${lines.map((l, i) => html`
            <tr data-line-row data-line-id="${escape(l.id)}" class="${l.is_option ? 'line-option' : ''}">
              <td class="col-num">${i + 1}${l.is_option ? html`<br><span class="pill" style="font-size:0.7em">OPT</span>` : ''}</td>
              <td class="col-item">
                <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/lines/${escape(l.id)}" class="inline-form" id="line-form-${escape(l.id)}">
                  <div class="line-item-fields">
                    <input type="text" name="title" value="${escape(l.title ?? '')}" ${readOnly ? 'disabled' : ''}
                           placeholder="Title / Part #" class="line-title" data-autosave>
                    <input type="text" name="description" value="${escape(l.description ?? '')}" ${readOnly ? 'disabled' : ''}
                           placeholder="Description" class="line-desc" data-autosave>
                  </div>
                  <textarea name="line_notes" ${readOnly ? 'disabled' : ''}
                            placeholder="Item notes..." class="line-notes" data-autosave>${escape(l.line_notes ?? '')}</textarea>
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
          `)}
          ${!readOnly
            ? html`
              <tr class="new-line-row" data-line-row>
                <td class="col-num muted">${lines.length + 1}</td>
                <td class="col-item">
                  <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/lines" class="inline-form" id="new-line-form">
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
    <section class="card">
      <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}" class="stack-form" id="quote-footer-form">
        <fieldset ${readOnly ? 'disabled' : ''}>
          <label>
            <strong>Quote notes</strong>
            <textarea name="notes_customer" class="desc-textarea" placeholder="Notes to the customer (appears on the issued quote)">${escape(quote.notes_customer ?? '')}</textarea>
          </label>
          <label style="margin-top:0.75rem">
            <strong>Terms</strong>
            <textarea name="payment_terms" class="desc-textarea" placeholder="Payment terms, delivery terms, conditions...">${escape(quote.payment_terms ?? '')}</textarea>
          </label>
          <label style="margin-top:0.75rem">
            <strong>Delivery terms</strong>
            <textarea name="delivery_terms" class="desc-textarea" placeholder="EXW, FCA, FOB, DAP...">${escape(quote.delivery_terms ?? '')}</textarea>
          </label>

          <!-- Carry forward all required hidden fields for the save -->
          <input type="hidden" name="quote_type" value="${escape(quote.quote_type)}">
          <input type="hidden" name="title" value="${escape(quote.title ?? '')}">
          <input type="hidden" name="description" value="${escape(quote.description ?? '')}">
          <input type="hidden" name="valid_until" value="${escape(quote.valid_until ?? '')}">
          <input type="hidden" name="incoterms" value="${escape(quote.incoterms ?? '')}">
          <input type="hidden" name="delivery_estimate" value="${escape(quote.delivery_estimate ?? '')}">
          <input type="hidden" name="tax_amount" value="${quote.tax_amount != null ? escape(Number(quote.tax_amount).toFixed(2)) : '0'}">
          <input type="hidden" name="notes_internal" value="${escape(quote.notes_internal ?? '')}">
        </fieldset>

        ${!readOnly
          ? html`<div class="form-actions"><button type="submit" class="btn primary">Save</button></div>`
          : ''}
      </form>

      ${quote.notes_internal ? html`
        <div style="margin-top:0.75rem;padding:0.5rem 0.7rem;background:#fff8c5;border:1px solid #d4a72c;border-radius:var(--radius)">
          <strong style="font-size:0.85em">Internal notes (not visible to customer):</strong>
          <p style="margin:0.25rem 0 0;font-size:0.9em;white-space:pre-wrap">${escape(quote.notes_internal)}</p>
        </div>
      ` : ''}
    </section>
  `;

  // ── Auto-save script ───────────────────────────────────────────────
  const autoSaveScript = !readOnly ? html`
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
        var titleInput = newForm.querySelector('[name="title"]');
        if (titleInput) {
          titleInput.addEventListener('change', function() {
            if (titleInput.value.trim()) newForm.requestSubmit();
          });
        }
      }
    })();
    </script>
  ` : '';

  const body = html`${headerSection}${bannerCard}${detailsSection}${linesSection}${footerSection}${autoSaveScript}`;

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
