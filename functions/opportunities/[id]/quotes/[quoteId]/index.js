// functions/opportunities/[id]/quotes/[quoteId]/index.js
//
// GET  /opportunities/:id/quotes/:quoteId  — quote detail / editor
// POST /opportunities/:id/quotes/:quoteId  — update header fields
//
// The quote editor renders in three sections:
//   1. Header — title, description, validity, terms, cost_build link
//   2. Lines  — tabular line items (add row + per-row update/delete
//               is handled via dedicated /lines routes to keep this
//               handler simple)
//   3. Status + governance snapshots — read-only strip showing the
//               snapshotted tc/warranty/rate/sop revisions once the
//               quote has been submitted
//
// Status transitions (submit, revise, accept, reject, supersede,
// expire) live in sibling files:
//   submit.js, revise.js, accept.js, reject.js, supersede.js, expire.js
//
// Quotes in a terminal status (accepted, rejected, superseded, expired)
// are read-only — the header form and line routes refuse updates.

import { one, all, stmt, batch } from '../../../../lib/db.js';
import { auditStmt, diff } from '../../../../lib/audit.js';
import { now } from '../../../../lib/ids.js';
import { layout, htmlResponse, html, escape } from '../../../../lib/layout.js';
import { redirectWithFlash, formBody, readFlash } from '../../../../lib/http.js';
import {
  validateQuote,
  QUOTE_TYPE_LABELS,
  QUOTE_STATUS_LABELS,
} from '../../../../lib/validators.js';
import { fmtDollar } from '../../../../lib/pricing.js';

// Status values that put the quote into read-only mode. Once a quote is
// accepted/rejected/superseded/expired, its fields and lines can't be
// touched — create a new revision instead.
const READ_ONLY_STATUSES = new Set([
  'accepted',
  'rejected',
  'superseded',
  'expired',
]);

const UPDATE_FIELDS = [
  'title',
  'description',
  'valid_until',
  'incoterms',
  'payment_terms',
  'delivery_terms',
  'delivery_estimate',
  'tax_amount',
  'cost_build_id',
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
            sup.number AS supersedes_number, sup.revision AS supersedes_revision,
            cb.label AS cost_build_label, cb.status AS cost_build_status,
            subu.display_name AS submitted_by_name, subu.email AS submitted_by_email
       FROM quotes q
       LEFT JOIN opportunities o ON o.id = q.opportunity_id
       LEFT JOIN quotes sup      ON sup.id = q.supersedes_quote_id
       LEFT JOIN cost_builds cb  ON cb.id = q.cost_build_id
       LEFT JOIN users subu      ON subu.id = q.submitted_by_user_id
      WHERE q.id = ?`,
    [quoteId]
  );
  if (!quote || quote.opportunity_id !== oppId) return notFound(context);

  const lines = await all(
    env.DB,
    `SELECT * FROM quote_lines WHERE quote_id = ? ORDER BY sort_order, id`,
    [quoteId]
  );

  // Cost builds on the same opportunity — used to populate the
  // cost_build_id picker. Show locked and draft alike; the user's
  // expected to link a locked build for a real submission but we don't
  // enforce it here.
  const costBuilds = await all(
    env.DB,
    `SELECT id, label, status FROM cost_builds
      WHERE opportunity_id = ?
      ORDER BY created_at DESC`,
    [oppId]
  );

  // Cost build labels map — used for the per-line cost build dropdown.
  const hasCostBuilds = costBuilds.length > 0;

  // Revision history: all quotes on this opportunity with the same
  // quote_type, ordered by created_at. Used to render a "Rev A/B/C"
  // breadcrumb at the top of the editor so the user can see related
  // revisions at a glance.
  const revisionHistory = await all(
    env.DB,
    `SELECT id, number, revision, status, created_at
       FROM quotes
      WHERE opportunity_id = ? AND quote_type = ?
      ORDER BY created_at`,
    [oppId, quote.quote_type]
  );

  const readOnly = READ_ONLY_STATUSES.has(quote.status);

  const subtotal = lines.reduce((a, l) => a + Number(l.extended_price ?? 0), 0);
  const total = subtotal + Number(quote.tax_amount ?? 0);

  const flash = readFlash(url);

  // Helper: render cost build options for the per-line dropdown.
  function renderCbOptions(selectedId) {
    return html`
      <option value="">—</option>
      ${costBuilds.map((cb) => html`
        <option value="${escape(cb.id)}" ${selectedId === cb.id ? 'selected' : ''}>
          ${escape(cb.label || '(unlabeled)')} ${cb.status === 'locked' ? '[locked]' : ''}
        </option>
      `)}
    `;
  }

  // --- Header section -----------------------------------------------------
  const headerSection = html`
    <section class="card">
      <div class="card-header">
        <div>
          <h1>
            ${escape(quote.title || quote.number)}
            <span class="header-value" id="q-header-total">${fmtDollar(total)}</span>
          </h1>
          <p class="muted">
            <code>${escape(quote.number)}</code>
            · Rev ${escape(quote.revision)}
            · ${escape(QUOTE_TYPE_LABELS[quote.quote_type] ?? quote.quote_type)}
            · <span class="pill ${statusPillClass(quote.status)}">${escape(QUOTE_STATUS_LABELS[quote.status] ?? quote.status)}</span>
            · opportunity <a href="/opportunities/${escape(oppId)}">${escape(quote.opp_number)}</a>
            ${quote.supersedes_quote_id
              ? html` · supersedes <a href="/opportunities/${escape(oppId)}/quotes/${escape(quote.supersedes_quote_id)}">${escape(quote.supersedes_number ?? '')} Rev ${escape(quote.supersedes_revision ?? '')}</a>`
              : ''}
          </p>
        </div>
        <div class="header-actions">
          <a class="btn" href="/opportunities/${escape(oppId)}?tab=quotes">Back to quotes</a>
        </div>
      </div>

      ${revisionHistory.length > 1
        ? html`
          <div class="revision-strip">
            <strong>Revisions:</strong>
            ${revisionHistory.map((r, i) => html`
              ${i > 0 ? ' · ' : ''}
              ${r.id === quote.id
                ? html`<strong>Rev ${escape(r.revision)}</strong>`
                : html`<a href="/opportunities/${escape(oppId)}/quotes/${escape(r.id)}">Rev ${escape(r.revision)}</a>`}
              <span class="muted">(${escape(QUOTE_STATUS_LABELS[r.status] ?? r.status)})</span>
            `)}
          </div>`
        : ''}
    </section>
  `;

  // --- Status transition strip --------------------------------------------
  const transitionStrip = html`
    <section class="card">
      <h2>Status</h2>
      <p class="muted">Current: <strong>${escape(QUOTE_STATUS_LABELS[quote.status] ?? quote.status)}</strong></p>
      <div class="transition-row">
        ${quote.status === 'draft' ? html`
          <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/submit-internal-review" class="inline-form">
            <button class="btn" type="submit">Send to internal review</button>
          </form>
        ` : ''}
        ${quote.status === 'internal_review' ? html`
          <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/approve-internal" class="inline-form">
            <button class="btn" type="submit">Approve (internal)</button>
          </form>
          <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/return-to-draft" class="inline-form">
            <button class="btn" type="submit">Return to draft</button>
          </form>
        ` : ''}
        ${quote.status === 'approved_internal' ? html`
          <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/submit" class="inline-form">
            <button class="btn primary" type="submit">Submit to customer</button>
          </form>
          <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/return-to-draft" class="inline-form">
            <button class="btn" type="submit">Return to draft</button>
          </form>
        ` : ''}
        ${quote.status === 'submitted' ? html`
          <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/accept" class="inline-form">
            <button class="btn primary" type="submit">Accept</button>
          </form>
          <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/reject" class="inline-form">
            <button class="btn" type="submit">Reject</button>
          </form>
          <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/expire" class="inline-form">
            <button class="btn" type="submit">Mark expired</button>
          </form>
        ` : ''}
        ${!readOnly ? html`
          <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/revise" class="inline-form">
            <button class="btn" type="submit" title="Create a new revision based on this quote">Create new revision</button>
          </form>
        ` : html`
          <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/revise" class="inline-form">
            <button class="btn primary" type="submit" title="Create a new revision based on this quote">Create new revision</button>
          </form>
        `}
        ${!readOnly && quote.status !== 'draft' ? html`
          <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/delete"
                class="inline-form"
                onsubmit="return confirm('Delete this quote revision? This cannot be undone.');">
            <button class="btn danger" type="submit">Delete</button>
          </form>
        ` : ''}
        ${quote.status === 'draft' ? html`
          <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/delete"
                class="inline-form"
                onsubmit="return confirm('Delete this quote revision? This cannot be undone.');">
            <button class="btn danger" type="submit">Delete</button>
          </form>
        ` : ''}
      </div>

      ${quote.submitted_at
        ? html`
          <div class="governance-snapshot">
            <h3>Governance snapshot (at submission)</h3>
            <p class="muted">
              Submitted ${escape(formatTimestamp(quote.submitted_at))}
              by ${escape(quote.submitted_by_name ?? quote.submitted_by_email ?? 'unknown')}
            </p>
            <ul class="plain">
              <li><strong>T&amp;Cs revision:</strong> ${escape(quote.tc_revision ?? '—')}</li>
              <li><strong>Warranty revision:</strong> ${escape(quote.warranty_revision ?? '—')}</li>
              <li><strong>Rate schedule revision:</strong> ${escape(quote.rate_schedule_revision ?? '—')}</li>
              <li><strong>Refurb SOP revision:</strong> ${escape(quote.sop_revision ?? '—')}</li>
            </ul>
          </div>`
        : html`
          <p class="muted">Governance revisions will be snapshotted when the quote is submitted to the customer.</p>
        `}
    </section>
  `;

  // --- Header-fields edit form --------------------------------------------
  const editForm = html`
    <section class="card">
      <h2>Quote details</h2>
      ${readOnly
        ? html`<p class="muted">This quote is ${escape(quote.status)} and cannot be edited. Create a new revision to make changes.</p>`
        : ''}
      <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}" class="stack-form">
        <fieldset ${readOnly ? 'disabled' : ''}>
          <label>
            Title
            <input type="text" name="title" value="${escape(quote.title ?? '')}"
                   placeholder="${escape(quote.number)} — short descriptor">
          </label>
          <label>
            Description
            <textarea name="description" rows="3">${escape(quote.description ?? '')}</textarea>
          </label>

          <div class="form-grid">
            <label>
              Valid until
              <input type="date" name="valid_until" value="${escape(quote.valid_until ?? '')}">
            </label>
            <label>
              Incoterms
              <input type="text" name="incoterms" value="${escape(quote.incoterms ?? '')}" placeholder="EXW / FCA / DAP / ...">
            </label>
            <label>
              Payment terms
              <input type="text" name="payment_terms" value="${escape(quote.payment_terms ?? '')}" placeholder="Net 30 / 50% down / ...">
            </label>
            <label>
              Delivery terms
              <input type="text" name="delivery_terms" value="${escape(quote.delivery_terms ?? '')}">
            </label>
            <label>
              Delivery estimate
              <input type="text" name="delivery_estimate" value="${escape(quote.delivery_estimate ?? '')}" placeholder="14–16 weeks ARO">
            </label>
            <label>
              Tax amount ($)
              <input type="text" name="tax_amount" value="${quote.tax_amount != null ? escape(Number(quote.tax_amount).toFixed(2)) : ''}">
            </label>
            <label>
              Linked cost build
              <select name="cost_build_id">
                <option value="">— none —</option>
                ${costBuilds.map((cb) => html`
                  <option value="${escape(cb.id)}" ${cb.id === quote.cost_build_id ? 'selected' : ''}>
                    ${escape(cb.label || '(unlabeled)')} ${cb.status === 'locked' ? '[locked]' : ''}
                  </option>
                `)}
              </select>
            </label>
          </div>

          <label>
            Internal notes
            <textarea name="notes_internal" rows="2" placeholder="Visible to C-LARS only">${escape(quote.notes_internal ?? '')}</textarea>
          </label>
          <label>
            Customer notes
            <textarea name="notes_customer" rows="2" placeholder="Will appear on the issued quote document">${escape(quote.notes_customer ?? '')}</textarea>
          </label>
        </fieldset>

        ${!readOnly
          ? html`<div class="form-actions"><button type="submit" class="btn primary">Save quote</button></div>`
          : ''}
      </form>
    </section>
  `;

  // --- Lines section ------------------------------------------------------
  const linesSection = html`
    <section class="card">
      <div class="card-header">
        <h2>Line items</h2>
        <div class="header-actions">
          ${!readOnly && quote.cost_build_id ? html`
            <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/populate-from-cost-build" class="inline-form"
                  onsubmit="return confirm('This will add lines from the linked cost build. Continue?');">
              <button class="btn small" type="submit">Populate from cost build</button>
            </form>
          ` : ''}
          <span class="header-value" id="q-lines-subtotal">${fmtDollar(subtotal)} subtotal</span>
        </div>
      </div>

      <table class="data compact" data-live-calc="quote-lines">
        <thead>
          <tr>
            <th>#</th>
            <th>Description</th>
            ${hasCostBuilds ? html`<th>Cost build</th>` : ''}
            <th class="num">Qty</th>
            <th>Unit</th>
            <th class="num">Unit price</th>
            <th class="num">Extended</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${lines.map((l, i) => html`
            <tr data-line-row>
              <td>${i + 1}</td>
              <td>
                <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/lines/${escape(l.id)}" class="inline-form" id="line-form-${escape(l.id)}">
                  <input type="text" name="description" value="${escape(l.description ?? '')}" ${readOnly ? 'disabled' : ''} style="width: 100%;">
                </form>
              </td>
              ${hasCostBuilds ? html`
                <td>
                  <select name="cost_build_id" form="line-form-${escape(l.id)}" ${readOnly ? 'disabled' : ''}>
                    ${renderCbOptions(l.cost_build_id)}
                  </select>
                </td>
              ` : ''}
              <td class="num">
                <input type="text" name="quantity" form="line-form-${escape(l.id)}" value="${escape(l.quantity ?? '')}" ${readOnly ? 'disabled' : ''} class="num-input">
              </td>
              <td>
                <input type="text" name="unit" form="line-form-${escape(l.id)}" value="${escape(l.unit ?? '')}" ${readOnly ? 'disabled' : ''} style="width: 100%;">
              </td>
              <td class="num">
                <input type="text" name="unit_price" form="line-form-${escape(l.id)}" value="${escape(l.unit_price ?? '')}" ${readOnly ? 'disabled' : ''} class="num-input">
              </td>
              <td class="num" data-line-extended>${fmtDollar(l.extended_price)}</td>
              <td class="row-actions">
                ${!readOnly ? html`
                  <button class="btn small" type="submit" form="line-form-${escape(l.id)}">Save</button>
                  <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/lines/${escape(l.id)}/delete" class="inline-form">
                    <button class="btn small danger" type="submit">×</button>
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
                    <input type="text" name="description" placeholder="New line item…" style="width: 100%;">
                  </form>
                </td>
                ${hasCostBuilds ? html`
                  <td>
                    <select name="cost_build_id" form="new-line-form">
                      ${renderCbOptions(null)}
                    </select>
                  </td>
                ` : ''}
                <td class="num">
                  <input type="text" name="quantity" form="new-line-form" value="1" class="num-input">
                </td>
                <td>
                  <input type="text" name="unit" form="new-line-form" value="ea" style="width: 100%;">
                </td>
                <td class="num">
                  <input type="text" name="unit_price" form="new-line-form" class="num-input" placeholder="0">
                </td>
                <td class="num" data-line-extended>\u2014</td>
                <td class="row-actions">
                  <button class="btn small primary" type="submit" form="new-line-form">+</button>
                </td>
              </tr>
            `
            : ''}
          <tr class="totals-row">
            <td colspan="${hasCostBuilds ? 6 : 5}" class="num"><strong>Subtotal</strong></td>
            <td class="num" id="q-subtotal"><strong>${fmtDollar(subtotal)}</strong></td>
            <td></td>
          </tr>
          <tr class="totals-row">
            <td colspan="${hasCostBuilds ? 6 : 5}" class="num">Tax</td>
            <td class="num">${fmtDollar(Number(quote.tax_amount ?? 0))}</td>
            <td></td>
          </tr>
          <tr class="totals-row">
            <td colspan="${hasCostBuilds ? 6 : 5}" class="num"><strong>Total</strong></td>
            <td class="num" id="q-total"><strong>${fmtDollar(total)}</strong></td>
            <td></td>
          </tr>
        </tbody>
      </table>
    </section>
  `;

  const body = html`${headerSection}${transitionStrip}${editForm}${linesSection}`;

  return htmlResponse(
    layout(
      `${quote.number} Rev ${quote.revision} — ${quote.title || ''}`,
      body,
      {
        user,
        env: data?.env,
        activeNav: '/opportunities',
        flash,
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

  const input = await formBody(request);
  // quote_type is immutable after creation — drop from the payload.
  const { ok, value, errors } = validateQuote(input, { requireType: false });
  if (!ok) {
    const firstErr = Object.values(errors)[0] ?? 'Invalid input.';
    return redirectWithFlash(
      `/opportunities/${oppId}/quotes/${quoteId}`,
      firstErr,
      'error'
    );
  }

  // Verify cost_build_id belongs to this opportunity (if supplied).
  if (value.cost_build_id) {
    const cb = await one(
      env.DB,
      'SELECT id FROM cost_builds WHERE id = ? AND opportunity_id = ?',
      [value.cost_build_id, oppId]
    );
    if (!cb) {
      return redirectWithFlash(
        `/opportunities/${oppId}/quotes/${quoteId}`,
        'Selected cost build does not belong to this opportunity.',
        'error'
      );
    }
  }

  const ts = now();
  const after = { ...before, ...value };
  const changes = diff(before, after, UPDATE_FIELDS);

  // Recompute total_price from current lines + the new tax amount.
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
          SET title = ?,
              description = ?,
              valid_until = ?,
              incoterms = ?,
              payment_terms = ?,
              delivery_terms = ?,
              delivery_estimate = ?,
              tax_amount = ?,
              subtotal_price = ?,
              total_price = ?,
              cost_build_id = ?,
              notes_internal = ?,
              notes_customer = ?,
              updated_at = ?
        WHERE id = ?`,
      [
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
        value.cost_build_id,
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
    case 'draft':             return '';
    case 'internal_review':   return 'pill-warn';
    case 'approved_internal': return 'pill-warn';
    case 'submitted':         return 'pill-success';
    case 'accepted':          return 'pill-success';
    case 'rejected':          return 'pill-locked';
    case 'superseded':        return 'pill-locked';
    case 'expired':           return 'pill-locked';
    default:                  return '';
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
