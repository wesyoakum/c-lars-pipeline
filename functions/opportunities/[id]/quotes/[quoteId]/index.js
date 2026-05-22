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
import { hasRole } from '../../../../lib/auth.js';
import { now } from '../../../../lib/ids.js';
import { layout, htmlResponse, html, raw, escape } from '../../../../lib/layout.js';
import { redirectWithFlash, formBody, readFlash } from '../../../../lib/http.js';
import { ICON_CALCULATOR, ICON_CALCULATOR_PLUS, ICON_PDF, ICON_DOCX, ICON_MIC, ICON_SPARKLE } from '../../../../lib/icons.js';
import {
  validateQuote,
  allowedQuoteTypes,
  parseTransactionTypes,
  parseQuoteTypes,
  isHybridQuote,
  quoteTypeDisplayLabel,
  quoteTypeSubtitle,
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
import { loadQuoteTermDefaultsMap, getEffectiveValidityDays } from '../../../../lib/quote-term-defaults.js';
import { loadEpsSchedule } from '../../../../lib/eps-schedule.js';
import { loadPaymentSchedules, renderScheduleText } from '../../../../lib/payment-schedules.js';
import { loadMilestoneMap } from '../../../../lib/katana-milestones.js';
import { parseQuoteSchedule, loadDefaultScheduleForType } from '../../../../lib/quote-payment-schedule.js';

const READ_ONLY_STATUSES = new Set([
  'issued', 'revision_issued', 'accepted', 'rejected', 'expired', 'dead',
]);

const UPDATE_FIELDS = [
  'quote_type', 'title', 'description', 'valid_until', 'incoterms',
  'payment_terms', 'delivery_terms', 'delivery_estimate',
  'tax_amount', 'notes_internal', 'notes_customer',
];

// Phase 2c — Alpine store backing the "Push to Katana" button + modal
// at the top of the quote detail page. State is bootstrapped from
// window.__KATANA_PUSH_STATE__ which the GET handler injects. The
// store's getters (amountsSum, amountsMatch) keep the modal's "must
// equal $X" footer reactive as the user edits per-milestone amounts.
const KATANA_PUSH_SCRIPT = `
document.addEventListener('alpine:init', function () {
  var s = window.__KATANA_PUSH_STATE__ || {};
  Alpine.store('katanaPush', {
    showSection: !!s.showSection,
    fullyPushed: !!s.fullyPushed,
    partiallyPushed: !!s.partiallyPushed,
    anyPushed: !!s.anyPushed,
    canPush: !!s.canPush,
    blockReason: s.blockReason || '',
    katanaCustomerId: s.katanaCustomerId || null,
    katanaCustomerName: s.katanaCustomerName || '',
    quoteNumber: s.quoteNumber || '',
    quoteTotal: Number(s.quoteTotal) || 0,
    oppId: s.oppId,
    quoteId: s.quoteId,
    lineCount: Number(s.lineCount) || 0,
    linePushedCount: Number(s.linePushedCount) || 0,
    lineErrorCount: Number(s.lineErrorCount) || 0,
    lines: Array.isArray(s.lines) ? s.lines.map(function (l) {
      return {
        line_id: l.line_id,
        idx: Number(l.idx) || 0,
        title: String(l.title || ''),
        part_number: String(l.part_number || ''),
        quantity: Number(l.quantity) || 0,
        unit_price: Number(l.unit_price) || 0,
        extended_price: Number(l.extended_price) || 0,
        already_pushed: !!l.already_pushed,
        katana_sales_order_id: l.katana_sales_order_id || null,
        pushed_at: l.pushed_at || null,
        push_error: l.push_error || null,
        preview_order_no: String(l.preview_order_no || ''),
      };
    }) : [],
    milestones: (s.milestones || []).map(function (m) {
      return {
        percent: Number(m.percent) || 0,
        label: String(m.label || ''),
        katana_variant_id: Number(m.katana_variant_id) || 0,
        katana_sku: String(m.katana_sku || ''),
      };
    }),
    modalOpen: false,
    busy: false,
    orderNo: s.quoteNumber || '',
    customerRef: '',
    deliveryDate: '',
    additionalInfo: '',
    // Last push summary returned from the server (pushed_count, errors, etc.).
    // Surfaced inline after a push so the user knows what landed in Katana.
    lastPushResult: null,
    // Count of lines that haven't been pushed yet — the number of new
    // Katana sales orders the next click will create.
    get pendingLineCount() {
      var n = 0;
      for (var i = 0; i < this.lines.length; i++) if (!this.lines[i].already_pushed) n++;
      return n;
    },
    get badgeText() {
      if (this.fullyPushed) return '✓ All ' + this.lineCount + ' lines pushed to Katana';
      if (this.partiallyPushed) return '✓ ' + this.linePushedCount + ' of ' + this.lineCount + ' lines pushed';
      return '';
    },
    openModal: function () {
      if (!this.canPush) {
        // Multiple block reasons are joined with '; ' on the server.
        // Split into one-per-line so the alert reads as an actionable
        // checklist instead of a wall of text.
        var reasons = String(this.blockReason || 'unknown reason')
          .split('; ').filter(Boolean)
          .map(function(r, i) { return (i + 1) + '. ' + r; })
          .join('\\n');
        alert('Cannot push to Katana:\\n\\n' + reasons);
        return;
      }
      this.modalOpen = true;
    },
    closeModal: function () {
      if (this.busy) return;
      this.modalOpen = false;
    },
    push: function () {
      var self = this;
      if (self.pendingLineCount === 0) {
        alert('Nothing to push — every line already has a Katana sales order.');
        return;
      }
      self.busy = true;
      fetch('/opportunities/' + encodeURIComponent(self.oppId) + '/quotes/' + encodeURIComponent(self.quoteId) + '/push-to-katana', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          order_no: self.orderNo,
          customer_ref: self.customerRef,
          delivery_date: self.deliveryDate,
          additional_info: self.additionalInfo,
        }),
      }).then(function (r) {
        if (!r.ok) return r.json().then(function (d) { throw new Error(d && d.error || ('HTTP ' + r.status)); });
        return r.json();
      }).then(function (data) {
        self.lastPushResult = data;
        // Merge per-line results back into the local lines array so the
        // modal/badge update without a page reload.
        var idMap = {};
        (data.pushed || []).forEach(function (p) { idMap[p.line_id] = p; });
        var errMap = {};
        (data.errors || []).forEach(function (e) { errMap[e.line_id] = e; });
        for (var i = 0; i < self.lines.length; i++) {
          var ln = self.lines[i];
          if (idMap[ln.line_id]) {
            ln.already_pushed = true;
            ln.katana_sales_order_id = idMap[ln.line_id].katana_sales_order_id;
            ln.push_error = null;
          } else if (errMap[ln.line_id]) {
            ln.push_error = errMap[ln.line_id].error;
          }
        }
        self.linePushedCount = self.lines.filter(function (l) { return l.already_pushed; }).length;
        self.lineErrorCount  = self.lines.filter(function (l) { return l.push_error; }).length;
        self.fullyPushed     = self.lineCount > 0 && self.linePushedCount === self.lineCount;
        self.partiallyPushed = self.linePushedCount > 0 && !self.fullyPushed;
        self.anyPushed       = self.linePushedCount > 0;
        // Keep canPush true if there are still pending lines (re-push
        // covers the unpushed ones).
        self.canPush = self.canPush && self.pendingLineCount > 0;
        self.busy = false;
        // Close modal if everything pushed; keep it open so the user
        // can see partial / error state.
        if (self.lineErrorCount === 0 && self.fullyPushed) {
          self.modalOpen = false;
        }
      }).catch(function (err) {
        self.busy = false;
        alert('Push failed: ' + (err && err.message ? err.message : 'unknown error'));
      });
    },
    unlink: function () {
      var msg = this.fullyPushed
        ? 'Unlink all ' + this.linePushedCount + ' Katana sales orders for this quote?'
        : 'Unlink the ' + this.linePushedCount + ' Katana sales orders pushed so far?';
      msg += '\\n\\nThe Katana records stay in place; Pipeline just forgets the links.';
      if (!confirm(msg)) return;
      var self = this;
      self.busy = true;
      fetch('/opportunities/' + encodeURIComponent(self.oppId) + '/quotes/' + encodeURIComponent(self.quoteId) + '/katana-unlink', {
        method: 'POST',
        credentials: 'same-origin',
      }).then(function (r) {
        if (!r.ok) return r.json().then(function (d) { throw new Error(d && d.error || ('HTTP ' + r.status)); });
        return r.json();
      }).then(function () {
        for (var i = 0; i < self.lines.length; i++) {
          self.lines[i].already_pushed = false;
          self.lines[i].katana_sales_order_id = null;
          self.lines[i].pushed_at = null;
          self.lines[i].push_error = null;
        }
        self.linePushedCount = 0;
        self.lineErrorCount  = 0;
        self.fullyPushed     = false;
        self.partiallyPushed = false;
        self.anyPushed       = false;
        self.canPush         = !self.blockReason;
        self.lastPushResult  = null;
        self.busy = false;
      }).catch(function (err) {
        self.busy = false;
        alert('Unlink failed: ' + (err && err.message ? err.message : 'unknown error'));
      });
    },
  });
});
`;

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
            a.name AS account_name,
            a.katana_customer_id, a.katana_customer_name,
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
        AND superseded_at IS NULL
      ORDER BY uploaded_at DESC`,
    [quoteId]
  );

  // User-editable term defaults (migration 0024). Flat map like
  //   { spares: { payment_terms: '...' }, eps: { delivery_terms: '...' } }
  // Serialized into JS below so the flatTerms / plainTerms Alpine
  // components can consult (or save) defaults without a round-trip.
  const termDefaults = await loadQuoteTermDefaultsMap(env);

  // Admin-editable New Product default payment schedule (migration 0040).
  // Serialized into JS below so the epsTerms Alpine component renders
  // the configured rows instead of the old hardcoded 25/25/25/15/10
  // string. Hybrid/non-New Product quotes ignore this blob.
  const epsSchedule = await loadEpsSchedule(env);
  const paymentSchedules = await loadPaymentSchedules(env);

  // Override the static payment_terms defaults with the rendered schedule
  // text so flatTerms/plainTerms checkboxes use the admin-configured
  // milestone rows instead of the legacy free-text defaults.
  for (const [qt, sched] of Object.entries(paymentSchedules)) {
    const rendered = renderScheduleText(sched);
    if (rendered) {
      if (!termDefaults[qt]) termDefaults[qt] = {};
      termDefaults[qt].payment_terms = rendered;
    }
  }

  // Step 2/3 — Katana per-line push state. Each quote line becomes its
  // own Katana sales order (Adam's D079 pattern). The milestone
  // schedule is sourced from quotes.payment_schedule (Step 3, per-quote
  // custom) when set, else from the site-wide map (Step 2).
  const milestoneMap = await loadMilestoneMap(env);
  const quoteSchedule = parseQuoteSchedule(quote.payment_schedule);
  // Per-quote-type default schedule (migration 0075). The editor uses
  // this for "Copy from <type> default" and shows the user when the
  // current per-quote schedule has drifted from the type default.
  const typeDefaultSchedule = await loadDefaultScheduleForType(env, quote.quote_type);
  const quoteTotal = Number(quote.total_price) || 0;

  // Pre-derive per-line push state from the already-loaded `lines`.
  const pushableLines = lines.filter((l) => {
    const active = (l.is_active == null ? 1 : l.is_active) ? true : false;
    const isOption = (l.is_option == null ? 0 : l.is_option) ? true : false;
    return active && !isOption;
  });
  const linePushedCount = pushableLines.filter((l) => l.katana_sales_order_id).length;
  const lineErrorCount  = pushableLines.filter((l) => l.katana_push_error).length;
  const fullyPushed     = pushableLines.length > 0 && linePushedCount === pushableLines.length;
  const partiallyPushed = linePushedCount > 0 && !fullyPushed;
  const anyPushed       = linePushedCount > 0;

  // Resolve which schedule will actually drive the push. quote
  // payment_schedule wins; site map is the fallback. The resolved
  // schedule also powers the modal's "Milestone schedule" preview.
  const siteRows = milestoneMap?.milestones || [];
  let resolvedScheduleRows;
  let scheduleSource;
  if (quoteSchedule && Array.isArray(quoteSchedule.rows) && quoteSchedule.rows.length > 0) {
    resolvedScheduleRows = quoteSchedule.rows.map((r, i) => {
      const fallback = siteRows[i] || {};
      return {
        percent: Number(r.percent) || 0,
        label: String(r.label || ''),
        weeks: r.weeks != null && r.weeks !== '' ? Number(r.weeks) : null,
        katana_variant_id: r.katana_variant_id || fallback.katana_variant_id || null,
        katana_sku: r.katana_sku || fallback.katana_sku || '',
      };
    });
    scheduleSource = 'quote';
  } else {
    resolvedScheduleRows = siteRows.map((m) => ({
      percent: Number(m.percent) || 0,
      label: String(m.label || ''),
      weeks: null,
      katana_variant_id: m.katana_variant_id || null,
      katana_sku: m.katana_sku || '',
    }));
    scheduleSource = siteRows.length > 0 ? 'site' : 'none';
  }

  const katanaBlockReasons = [];
  if (!quote.katana_customer_id) katanaBlockReasons.push('Account is not mapped to a Katana customer (Settings → Katana customers)');
  if (resolvedScheduleRows.length === 0) katanaBlockReasons.push('No milestone schedule (set one below, or configure the site default at Settings → Katana milestones)');
  if (resolvedScheduleRows.some((r) => !r.katana_variant_id)) katanaBlockReasons.push('One or more milestones have no Katana variant — pick variants on the schedule editor below or extend the site default');
  if (pushableLines.length === 0) katanaBlockReasons.push('Quote has no active (non-option) lines');
  if (quoteTotal <= 0) katanaBlockReasons.push('Quote total is $0');

  const milestonesForState = resolvedScheduleRows.map((r) => ({
    percent: r.percent,
    label: r.label,
    katana_variant_id: r.katana_variant_id,
    katana_sku: r.katana_sku || '',
  }));
  const linesForState = pushableLines.map((l, i) => {
    const lineIdx = i + 1;
    const linePadded = String(lineIdx).padStart(2, '0');
    const linePrice = Number(l.unit_price) || 0;
    const lineQty   = Number(l.quantity) || 0;
    return {
      line_id: l.id,
      idx: lineIdx,
      title: (l.title || l.description || '').toString().slice(0, 120) || `Line ${lineIdx}`,
      part_number: l.part_number || '',
      quantity: lineQty,
      unit_price: linePrice,
      extended_price: Math.round(linePrice * lineQty * 100) / 100,
      already_pushed: !!l.katana_sales_order_id,
      katana_sales_order_id: l.katana_sales_order_id || null,
      pushed_at: l.katana_sales_order_pushed_at || null,
      push_error: l.katana_push_error || null,
      // Per-SO name preview; the route also computes this server-side.
      preview_order_no: `${quote.number}-${linePadded}`,
    };
  });

  const katanaState = {
    showSection: quote.status === 'accepted',
    fullyPushed,
    partiallyPushed,
    anyPushed,
    canPush: quote.status === 'accepted' && !fullyPushed && katanaBlockReasons.length === 0,
    blockReason: katanaBlockReasons.join('; '),
    katanaCustomerId: quote.katana_customer_id || null,
    katanaCustomerName: quote.katana_customer_name || '',
    quoteNumber: quote.number,
    quoteTotal,
    oppId,
    quoteId,
    lineCount: pushableLines.length,
    linePushedCount,
    lineErrorCount,
    lines: linesForState,
    milestones: milestonesForState,
  };
  const katanaStateJson = JSON.stringify(katanaState).replace(/</g, '\\u003c');

  // Expiration display (Batch 6, migration 0038):
  //   * If the quote already has a valid_until, show it as-is.
  //   * Otherwise (draft/revision_draft) compute "today + N" live so
  //     drafts always display a plausible-looking date. N comes from
  //     the per-quote-type validity_days default; hybrid quotes use
  //     the minimum across parts. submit.js freezes the column at
  //     issuance.
  let displayValidUntil = quote.valid_until || '';
  if (!displayValidUntil) {
    const n = await getEffectiveValidityDays(env, quote.quote_type, 14);
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + n);
    displayValidUntil = d.toISOString().slice(0, 10);
  }

  const readOnly = READ_ONLY_STATUSES.has(quote.status);
  // Per-quote display toggle (migration 0027) — hides the discount
  // editors on this quote when false. Stored discount data is still
  // applied to totals / PDFs regardless.
  const showDiscounts = quote.show_discounts === 1 || quote.show_discounts === true;

  // Migration 0086 — parent/child grouping and is_active.
  //
  // childrenByParent: parent_line_id -> [child rows], in their existing
  // sort_order. parentIds: set of line ids that have ≥1 child (so the
  // editor treats them as group headers).
  //
  // Calculations: a line is included in the subtotal iff it is
  // (a) active (is_active != 0) AND
  // (b) NOT a parent (parents carry no own price; their displayed
  //     total is derived from their children, which are counted
  //     individually).
  const childrenByParent = new Map();
  const parentIds = new Set();
  for (const l of lines) {
    if (l.parent_line_id) {
      if (!childrenByParent.has(l.parent_line_id)) {
        childrenByParent.set(l.parent_line_id, []);
      }
      childrenByParent.get(l.parent_line_id).push(l);
      parentIds.add(l.parent_line_id);
    }
  }
  const isLineActive = (l) => Number(l.is_active ?? 1) !== 0;
  const lineCountsTowardTotals = (l) => isLineActive(l) && !parentIds.has(l.id);
  const childrenSum = (parentLineId) =>
    (childrenByParent.get(parentLineId) || [])
      .filter(isLineActive)
      .reduce((s, c) => s + Number(c.extended_price ?? 0), 0);
  const subtotal = lines.reduce(
    (a, l) => (lineCountsTowardTotals(l) ? a + Number(l.extended_price ?? 0) : a),
    0
  );
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

  // Hoisted up from the banner-card section (was line ~345) because
  // v0.395 moved the editable type dropdown into the header-card
  // subtitle row above. The header is rendered earlier in the same
  // template literal, so these consts have to be declared before the
  // template touches them — otherwise we hit a temporal-dead-zone
  // ReferenceError, which surfaces as a Cloudflare 1101 in production.
  const quoteTypeOptions = allowedQuoteTypes(quote.opp_transaction_type);
  const isHybrid = isHybridQuote(quote.quote_type);

  const patchUrl = `/opportunities/${oppId}/quotes/${quoteId}/patch`;

  // Pick the default address to show. 'both' rows count as billing.
  const defaultAddr = addresses.find(a => (a.kind === 'billing' || a.kind === 'both') && a.is_default)
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
          <p class="muted" style="margin:0.15rem 0 0;font-size:0.85em;display:flex;align-items:center;gap:0.4rem;flex-wrap:wrap">
            ${readOnly || isHybrid
              ? html`<span>${escape(quoteTypeDisplayLabel(quote.quote_type))}${isHybrid ? html` <span class="pill" style="font-size:0.85em">HYBRID</span>` : ''}</span>`
              : html`<select class="header-type-select"
                             style="font-size:inherit;padding:0.05rem 0.3rem;border:1px solid var(--border);background:var(--bg);border-radius:4px;color:inherit"
                             @change="window._qPatch('quote_type', $event.target.value)">
                  ${quoteTypeOptions.map(qt => html`
                    <option value="${escape(qt)}" ${qt === quote.quote_type ? 'selected' : ''}>
                      ${escape(QUOTE_TYPE_LABELS[qt] ?? qt)}
                    </option>
                  `)}
                </select>`}
            <span>· ${escape(quote.revision)}</span>
            ${quote.title ? html`<span>· ${escape(quote.title)}</span>` : ''}
            ${quote.supersedes_quote_id
              ? html`<span>· supersedes <a href="/opportunities/${escape(oppId)}/quotes/${escape(quote.supersedes_quote_id)}">${escape(quote.supersedes_number ?? '')} ${escape(quote.supersedes_revision ?? '')}</a></span>`
              : ''}
          </p>
        </div>
        <div class="header-actions-stack">
          <a class="back-link" href="/opportunities/${escape(quote.opportunity_id)}?tab=quotes">\u2190 Quotes</a>
          <div class="header-actions">
            ${user && user.email === 'wes.yoakum@c-lars.com' ? html`<button type="button" class="aii-page-capture-btn"
                    title="Capture an audio note for this quote" aria-label="Capture audio note"
                    onclick="window.PipelineAICapture && window.PipelineAICapture.open({ refType: 'quote', refId: '${escape(quote.id)}', refLabel: '${escape(quote.number)} \u2014 ${escape((quote.title || '').slice(0, 60))}' })">
              <span class="aii-page-capture-icon">${raw(ICON_MIC)}</span>
            </button>` : ''}
            ${isDraft && hasRole(user, 'sales') ? html`
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
              <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/reject"
                    onsubmit="window.Pipeline.submitFormWithBlockerCheck(this, 'Reject this quote'); return false;"
                    class="inline-form">
                <button class="btn" type="submit">Reject</button>
              </form>
              <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/expire" class="inline-form">
                <button class="btn danger" type="submit">Cancel</button>
              </form>
            ` : ''}
            ${quote.status === 'accepted' ? html`
              <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/start-oc" class="inline-form">
                <button class="btn primary" type="submit" title="Create (or jump to) the job for this opportunity and open the Issue OC form">Start Order Confirmation</button>
              </form>
              <!-- Empty x-data so Alpine processes the directives below.
                   display:contents keeps these elements direct flex children
                   of .header-actions so button spacing is identical to the
                   rest of the bar. -->
              <div x-data style="display:contents">
                <!-- Already-pushed badge. Hidden by default via x-cloak;
                     shows when ANY line is pushed (full or partial).
                     Text is "All N lines pushed" or "X of N lines pushed". -->
                <span x-cloak x-show="$store.katanaPush && $store.katanaPush.anyPushed"
                      class="katana-pushed-badge"
                      :title="($store.katanaPush && $store.katanaPush.lineErrorCount) ? ($store.katanaPush.lineErrorCount + ' line error(s) — see modal') : 'Click to manage'">
                  <span x-text="$store.katanaPush && $store.katanaPush.badgeText"></span>
                  <button type="button" class="katana-pushed-unlink"
                          @click="$store.katanaPush.unlink()"
                          :disabled="$store.katanaPush && $store.katanaPush.busy"
                          title="Unlink all (Katana sales orders are left in place)">&times;</button>
                </span>
                <!-- Push to Katana button. Always rendered + always
                     clickable. When canPush is false the click handler
                     surfaces the block reason via an alert (browsers
                     suppress @click on :disabled buttons, which made
                     blocked clicks look broken). -->
                <button type="button" class="btn"
                        x-show="!($store.katanaPush && $store.katanaPush.fullyPushed)"
                        @click="$store.katanaPush && $store.katanaPush.openModal()"
                        :title="($store.katanaPush && $store.katanaPush.canPush) ? ('Push ' + ($store.katanaPush.pendingLineCount || 0) + ' line(s) to Katana, one sales order per line') : ('Blocked: ' + ($store.katanaPush && $store.katanaPush.blockReason || 'Katana not ready') + '. Click for details.')">
                  <span x-text="($store.katanaPush && $store.katanaPush.partiallyPushed) ? 'Push remaining lines' : 'Push to Katana'">Push to Katana</span>
                </button>
                <!-- Inline block-reason chip. Visible whenever the push
                     would be blocked but the button is still showing
                     (i.e. not fully-pushed). Surfaces the reason
                     without requiring a hover or a click. -->
                <span x-cloak
                      x-show="$store.katanaPush && !$store.katanaPush.fullyPushed && !$store.katanaPush.canPush"
                      style="display:inline-flex;align-items:center;gap:.25rem;padding:.15rem .4rem;background:#fff8e1;border:1px solid #e0c97a;border-radius:3px;color:#9a6700;font-size:.75em;max-width:24rem;line-height:1.2"
                      :title="$store.katanaPush && $store.katanaPush.blockReason">
                  &#9888; <span x-text="$store.katanaPush && $store.katanaPush.blockReason"></span>
                </span>
              </div>
            ` : ''}
            ${quote.status === 'accepted' || quote.status === 'rejected' || quote.status === 'expired' ? html`
              <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/revise" class="inline-form">
                <button class="btn" type="submit">New revision</button>
              </form>
            ` : ''}
            ${isDraft ? html`
              <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/delete"
                    class="inline-form"
                    data-quote-number="${escape(quote.number)}"
                    data-quote-revision="${escape(quote.revision)}"
                    data-line-count="${escape(String(lines?.length ?? 0))}"
                    onsubmit="return window.confirmDeleteQuote(this);">
                <button class="btn danger" type="submit">Delete</button>
              </form>
            ` : ''}
            <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/generate-pdf" class="inline-form" target="_blank" rel="noopener">
              <button class="btn btn-icon" type="submit" title="Generate PDF (opens in a new tab)" aria-label="Generate PDF">
                ${raw(ICON_PDF)}
              </button>
            </form>
            ${hasRole(user, 'sales') ? html`
            <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/generate-docx" class="inline-form" target="_blank" rel="noopener">
              <button class="btn btn-icon" type="submit" title="Download Word document (opens in a new tab)" aria-label="Download Word">
                ${raw(ICON_DOCX)}
              </button>
            </form>` : ''}
            <div class="quote-settings" x-data="quoteSettings(${showDiscounts ? 'true' : 'false'})" @click.outside="open = false">
              <button type="button" class="quote-settings-btn" @click="open = !open" aria-label="Quote settings" title="Quote settings">
                <svg class="quote-settings-icon" viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
                  <path d="M19.14 12.94c.04-.31.06-.62.06-.94 0-.32-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.5.5 0 0 0-.58-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.48.48 0 0 0-.58.22L2.74 8.87a.49.49 0 0 0 .12.61l2.03 1.58c-.04.31-.06.62-.06.94 0 .32.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.39.31.6.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.25.41.49.41h3.84c.24 0 .45-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.23.09.5 0 .6-.22l1.92-3.32c.12-.22.07-.49-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 0 1 8.4 12 3.6 3.6 0 0 1 12 8.4a3.6 3.6 0 0 1 3.6 3.6 3.6 3.6 0 0 1-3.6 3.6z"/>
                </svg>
              </button>
              <div class="quote-settings-panel" x-show="open" x-cloak @click.stop>
                <div class="quote-settings-row">
                  <div class="quote-settings-label">
                    <strong>Show discount fields</strong>
                    <span>Toggle the header and per-line discount editors. Existing discount data is preserved.</span>
                  </div>
                  <label class="toggle-switch" :class="{ 'toggle-switch--on': value }">
                    <input type="checkbox" :checked="value" @change="save($event.target.checked)">
                    <span class="toggle-slider"></span>
                  </label>
                </div>
              </div>
            </div>
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
  // T3.4 Sub-feature A — quoteTypeOptions / isHybrid moved above the
  // header section (v0.395 needed them earlier in the template).
  // quoteTypeParts is only used below in the line-items section; keep
  // it here.
  const quoteTypeParts = parseQuoteTypes(quote.quote_type);
  const bannerCard = html`
    <section class="card quote-doc-card quote-doc-first quote-banner">
      <div class="quote-banner-inner">
        <div>
          <h2 class="quote-banner-title">QUOTATION</h2>
          <p class="quote-banner-subtitle">${escape(quoteTypeSubtitle(quote.quote_type))}</p>
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
        ? (function () {
            // Prominent read-only banner. The message + color signal the
            // status at a glance; the action ("New revision") already
            // lives in the top action bar above, so the banner just has
            // to be impossible to miss.
            const kind =
              quote.status === 'expired' ? 'expired' :
              quote.status === 'accepted' ? 'accepted' :
              quote.status === 'rejected' || quote.status === 'dead' ? 'rejected' :
              'issued';
            const icon =
              kind === 'expired' ? '\u23F0' :
              kind === 'accepted' ? '\u2714' :
              kind === 'rejected' ? '\u2716' :
              '\uD83D\uDD12';
            const label = QUOTE_STATUS_LABELS[quote.status] ?? quote.status;
            const canRevise = quote.status === 'accepted' || quote.status === 'rejected' || quote.status === 'expired';
            return html`
              <div class="quote-readonly-banner quote-readonly-banner-${escape(kind)}">
                <span class="quote-readonly-banner-icon" aria-hidden="true">${raw(icon)}</span>
                <div class="quote-readonly-banner-body">
                  <strong class="quote-readonly-banner-title">This quote is ${escape((label || '').toLowerCase())}.</strong>
                  <span class="quote-readonly-banner-sub">Create a new revision to make changes.</span>
                </div>
                ${canRevise ? html`
                  <form method="post" action="/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/revise" class="inline-form">
                    <button class="btn primary quote-readonly-banner-btn" type="submit">New revision</button>
                  </form>
                ` : ''}
              </div>
            `;
          })()
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
                <div x-data="expirationPicker('${escape(displayValidUntil)}')">
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
      <div class="desc-inline-row" style="margin-top:0.5rem">
        <strong class="desc-inline-label">Description:</strong>
        <textarea name="description" placeholder="Scope description for the customer" class="desc-textarea"
                  ${readOnly ? 'disabled' : ''}
                  @change="patchField('description', $event.target.value)">${escape(quote.description ?? '')}</textarea>
      </div>
    </section>
  `;

  // ── 4. Line items card ─────────────────────────────────────────────
  const pbUrl = (lineId) => `/opportunities/${oppId}/quotes/${quoteId}/lines/${lineId}/price-build`;
  const optionSubtotal = lines
    .filter(l => l.is_option && lineCountsTowardTotals(l))
    .reduce((a, l) => a + Number(l.extended_price ?? 0), 0);
  const includedSubtotal = subtotal - optionSubtotal;

  // T3.4 Sub-feature A — per-section subtotals for hybrid quotes.
  // Sum extended_price of non-option lines grouped by line_type.
  // Unassigned lines (line_type NULL) get their own "Unassigned"
  // bucket so the user can see they still need to be tagged.
  // Inactive lines and parent (group header) lines are excluded — see
  // the comment on the main subtotal calc above.
  const sectionSubtotals = [];
  if (isHybrid) {
    const bucket = new Map();
    for (const key of quoteTypeParts) {
      bucket.set(key, { key, label: QUOTE_TYPE_LABELS[key] ?? key, total: 0, count: 0 });
    }
    bucket.set('_unassigned', { key: '_unassigned', label: 'Unassigned', total: 0, count: 0 });
    for (const l of lines) {
      if (l.is_option) continue;
      if (!lineCountsTowardTotals(l)) continue;
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

  // Build the rendered row order: every top-level row, then its
  // children inserted immediately below (preserving their sort_order
  // within the group). Each entry tags whether it's a top-level row,
  // a parent (group header), or a child so the renderer can branch on
  // row layout, indentation, and which action buttons appear.
  //
  // We also pre-compute reorder bounds (isFirstInGroup / isLastInGroup)
  // so the up/down arrows can be disabled at the edges. "Group" here
  // means the line's nesting bucket — top-level rows form one bucket,
  // each parent's children form their own.
  const topLevelLines = lines.filter(l => !l.parent_line_id);
  const displayRows = [];
  for (let i = 0; i < topLevelLines.length; i++) {
    const l = topLevelLines[i];
    const isParent = parentIds.has(l.id);
    displayRows.push({
      line: l,
      isParent,
      isChild: false,
      isFirstInGroup: i === 0,
      isLastInGroup: i === topLevelLines.length - 1,
    });
    if (isParent) {
      const kids = childrenByParent.get(l.id) || [];
      for (let j = 0; j < kids.length; j++) {
        displayRows.push({
          line: kids[j],
          isParent: false,
          isChild: true,
          isFirstInGroup: j === 0,
          isLastInGroup: j === kids.length - 1,
        });
      }
    }
  }

  // Migration 0086 — URL helpers for the new line endpoints + an
  // out-of-table form that the per-row "group" checkboxes submit to.
  const moveUrl   = (lineId) => `/opportunities/${oppId}/quotes/${quoteId}/lines/${lineId}/move`;
  const lineUrl   = (lineId) => `/opportunities/${oppId}/quotes/${quoteId}/lines/${lineId}`;
  const ungroupUrl= (lineId) => `/opportunities/${oppId}/quotes/${quoteId}/lines/${lineId}/ungroup`;
  const groupUrl  = `/opportunities/${oppId}/quotes/${quoteId}/lines/group`;
  const groupFormId = 'group-form';

  const linesSection = html`
    <section class="card quote-doc-card">
      <div class="card-header">
        <h2>Line items</h2>
        <div class="header-actions" style="display:flex;align-items:center;gap:0.4rem">
          ${!readOnly ? html`
            <button type="button" class="btn-icon" onclick="document.getElementById('library-search-modal').showModal()" title="Add from library" style="padding:.3rem .45rem">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A1.5 1.5 0 012.5 18V2A1.5 1.5 0 014 .5h10l4 4V18a1.5 1.5 0 01-1.5 1.5H4z"/><path d="M12 .5V5h4.5"/><path d="M7 10h6M7 13h4"/></svg>
            </button>
            <button type="button" class="btn-icon" onclick="document.getElementById('import-lines-modal').showModal()" title="Import lines from file" style="padding:.3rem .45rem">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v12a2 2 0 002 2h8a2 2 0 002-2V4a2 2 0 00-2-2z"/><path d="M10 6v6M7 9l3-3 3 3"/></svg>
            </button>
          ` : ''}
          <span class="header-value" id="q-lines-subtotal">${fmtDollar(includedSubtotal)} subtotal</span>
        </div>
      </div>

      ${!readOnly ? html`
        <form method="post" action="${groupUrl}" id="${groupFormId}" style="display:none"></form>
      ` : ''}

      <table class="data compact quote-lines-table" data-live-calc="quote-lines" id="quote-lines-table">
        <thead>
          <tr>
            ${!readOnly ? html`<th class="col-handle" style="width:28px"></th>` : ''}
            <th class="col-num" style="width:30px">#</th>
            <th class="col-item">Item</th>
            <th class="num col-qty">Qty</th>
            <th class="col-unit">Unit</th>
            <th class="num col-price">Unit price</th>
            <th class="num col-ext" style="width:130px">Ext</th>
          </tr>
        </thead>
        <tbody>
          ${displayRows.map((row, i) => {
            const l = row.line;
            const active = isLineActive(l);
            const isParent = row.isParent;
            const isChild = row.isChild;
            const lineHasDiscount =
              l.discount_amount != null ||
              l.discount_pct != null ||
              (l.discount_description && String(l.discount_description).trim() !== '') ||
              l.discount_is_phantom === 1;

            // Per-row actions cell — up/down reorder arrows, active
            // toggle, and (for top-level non-parent rows only) the
            // group-selection checkbox. The active toggle posts a
            // minimal form to the line update endpoint flipping
            // is_active; the autosave layer ignores it because it's a
            // hard submit, not a data-autosave field change.
            // Drag handle cell — click to select, drag to reorder.
            const handleCell = readOnly ? '' : html`
              <td class="col-handle" style="text-align:center;vertical-align:middle;cursor:grab;user-select:none"
                  data-drag-handle data-line-id="${escape(l.id)}">
                <span style="color:var(--muted,#999);font-size:1rem;line-height:1" title="Drag to reorder · Click to select">⠿</span>
              </td>
            `;

            // Parent (group header) rows render as a single big header
            // strip: title + line_notes spanning the data columns, and
            // a bold summed total in the price-ext column. Children's
            // individual rows follow below.
            if (isParent) {
              const parentSum = childrenSum(l.id);
              const parentRowClasses = [
                'line-group-parent',
                l.is_option ? 'line-option' : '',
                !active ? 'line-inactive' : '',
              ].filter(Boolean).join(' ');
              return html`
                <tr data-line-row data-line-id="${escape(l.id)}" class="${parentRowClasses}">
                  ${handleCell}
                  <td class="col-num">${i + 1}<br><span class="pill" style="font-size:0.7em;background:#e0e7ff;color:#3730a3;border-color:#c7d2fe">GROUP</span></td>
                  <td class="col-item" colspan="4">
                    <form method="post" action="${lineUrl(l.id)}" class="inline-form" id="line-form-${escape(l.id)}">
                      <div class="line-item-fields">
                        <input type="text" name="title" value="${escape(l.title ?? '')}" ${readOnly ? 'disabled' : ''}
                               placeholder="Group title" class="line-title group-parent-title"
                               style="font-weight:600" data-autosave>
                      </div>
                      <textarea name="line_notes" ${readOnly ? 'disabled' : ''}
                                placeholder="Group notes (appear on the PDF under the header)..."
                                class="line-notes" data-autosave>${escape(l.line_notes ?? '')}</textarea>
                      <input type="hidden" name="is_option" value="${l.is_option ? '1' : '0'}">
                      <input type="hidden" name="is_active" value="${active ? '1' : '0'}">
                    </form>
                  </td>
                  <td class="num col-ext" data-line-extended>
                    <div style="display:flex;align-items:center;justify-content:flex-end;gap:4px">
                      <strong>${fmtDollar(parentSum)}</strong>
                      ${!readOnly ? html`
                        <button type="button" class="line-eye-toggle line-active-toggle" data-line-id="${escape(l.id)}" data-target-active="${active ? '0' : '1'}" title="${active ? 'Exclude from quote' : 'Include in quote'}">
                          <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 10s4-7 9-7 9 7 9 7-4 7-9 7-9-7-9-7z"/><circle cx="10" cy="10" r="3"/>${!active ? '<line x1="3" y1="3" x2="17" y2="17" stroke-width="2.5"/>' : ''}</svg>
                        </button>
                        <button type="button" class="line-delete-btn" data-line-id="${escape(l.id)}" title="Delete line">&times;</button>
                      ` : ''}
                    </div>
                  </td>
                </tr>
              `;
            }

            const trClasses = [
              l.is_option ? 'line-option' : '',
              isChild ? 'line-group-child' : '',
              !active ? 'line-inactive' : '',
            ].filter(Boolean).join(' ');
            return html`
            <tr data-line-row data-line-id="${escape(l.id)}" class="${trClasses}">
              ${handleCell}
              <td class="col-num">
                ${isChild ? html`<span class="line-child-indent" style="color:var(--fg-muted)">↳ </span>` : ''}${i + 1}
                ${l.is_option ? html`<br><span class="pill" style="font-size:0.7em">OPT</span>` : ''}
                ${!active ? html`<br><span class="pill" style="font-size:0.7em;background:var(--bg-alt);color:var(--fg-muted)">INACTIVE</span>` : ''}
              </td>
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
                           placeholder="Title / Part #" class="line-title" data-autosave data-typeahead="library"
                           autocomplete="off">
                    <textarea name="description" ${readOnly ? 'disabled' : ''}
                              placeholder="Description" class="line-desc" rows="1" data-autosave>${escape(l.description ?? '')}</textarea>
                  </div>
                  <textarea name="line_notes" ${readOnly ? 'disabled' : ''}
                            placeholder="Item notes..." class="line-notes" data-autosave>${escape(l.line_notes ?? '')}</textarea>
                  ${!readOnly ? html`
                    <div style="display:flex;justify-content:flex-end;margin-top:0.2rem">
                      <button type="button" class="line-polish-btn"
                              data-line-polish-id="${escape(l.id)}"
                              title="Rewrite the title, description, and notes for a customer-facing tone"
                              style="display:inline-flex;align-items:center;gap:0.3rem;background:transparent;border:1px solid var(--border);border-radius:4px;padding:0.2rem 0.5rem;cursor:pointer;color:var(--fg-muted);font-size:0.8rem">
                        <span style="display:inline-flex;align-items:center;color:#6f42c1">${raw(ICON_SPARKLE)}</span>
                        <span>Polish with AI</span>
                      </button>
                    </div>
                  ` : ''}
                  ${showDiscounts ? renderLineDiscountEditor({ line: l, readOnly, hasDiscount: lineHasDiscount }) : ''}
                  <input type="hidden" name="is_option" value="${l.is_option ? '1' : '0'}">
                  <input type="hidden" name="is_active" value="${active ? '1' : '0'}">
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
                <div style="display:flex;align-items:center;justify-content:flex-end;gap:4px">
                  <span>${fmtDollar(l.extended_price)}</span>
                  ${!readOnly ? html`
                    <a href="${pbUrl(l.id)}" class="line-build-icon" title="${l.price_build_label ? 'Open price build ' + escape(l.build_number || l.price_build_label) : 'Add price build'}" style="color:${l.price_build_label ? '#3b82f6' : 'var(--muted,#999)'};text-decoration:none;display:inline-flex">
                      ${raw(ICON_CALCULATOR)}
                    </a>
                    <button type="button" class="line-eye-toggle line-active-toggle" data-line-id="${escape(l.id)}" data-target-active="${active ? '0' : '1'}" title="${active ? 'Exclude from quote' : 'Include in quote'}">
                      <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 10s4-7 9-7 9 7 9 7-4 7-9 7-9-7-9-7z"/><circle cx="10" cy="10" r="3"/>${!active ? '<line x1="3" y1="3" x2="17" y2="17" stroke-width="2.5"/>' : ''}</svg>
                    </button>
                    <button type="button" class="line-delete-btn" data-line-id="${escape(l.id)}" title="Delete line">&times;</button>
                  ` : ''}
                </div>
                ${l.build_quote_price != null && Math.abs(Number(l.unit_price ?? 0) - Number(l.build_quote_price)) > 0.01
                  ? html`<small class="muted" style="color:var(--warning);display:block;text-align:right" title="Price build suggests ${fmtDollar(l.build_quote_price)}/unit">Build: ${fmtDollar(l.build_quote_price)}</small>`
                  : ''}
              </td>
            </tr>
          `;})}
          ${!readOnly
            ? html`
              <tr class="new-line-row" data-line-row>
                <td class="col-handle" style="width:28px"></td>
                <td class="col-num" style="width:30px"><span class="muted">${displayRows.length + 1}</span></td>
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
              </tr>
            `
            : ''}
          ${isHybrid && sectionSubtotals.length > 0 ? sectionSubtotals.map(s => html`
            <tr class="totals-row section-subtotal-row ${s.key === '_unassigned' ? 'section-unassigned' : ''}">
              <td colspan="${readOnly ? 5 : 6}" class="num">
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
            <td colspan="${readOnly ? 5 : 6}" class="num"><strong>Subtotal</strong></td>
            <td class="num" id="q-subtotal"><strong>${fmtDollar(includedSubtotal)}</strong></td>
            <td></td>
          </tr>
          ${(() => {
            const inactives = lines.filter(l => !isLineActive(l) && !parentIds.has(l.id));
            if (!inactives.length) return '';
            const skipped = inactives.reduce((s, l) => s + Number(l.extended_price ?? 0), 0);
            return html`
              <tr class="totals-row">
                <td colspan="${readOnly ? 5 : 6}" class="num">
                  <span class="muted" style="font-size:0.85em">${inactives.length} inactive line${inactives.length === 1 ? '' : 's'} (excluded)</span>
                </td>
                <td class="num"><span class="muted">${fmtDollar(skipped)}</span></td>
                <td></td>
              </tr>
            `;
          })()}
          ${optionSubtotal > 0 ? html`
            <tr class="totals-row">
              <td colspan="${readOnly ? 5 : 6}" class="num"><em>Options (not included)</em></td>
              <td class="num"><em>${fmtDollar(optionSubtotal)}</em></td>
              <td></td>
            </tr>
          ` : ''}
          ${showDiscounts ? renderDiscountRow({ quote, readOnly, headerDiscountApplied }) : ''}
          <tr class="totals-row">
            <td colspan="${readOnly ? 5 : 6}" class="num"><strong>Total</strong></td>
            <td class="num" id="q-total"><strong>${fmtDollar(total)}</strong></td>
            <td></td>
          </tr>
        </tbody>
      </table>
    </section>
  `;

  // ── 5. Footer card ─────────────────────────────────────────────────
  const footerSection = html`
    <section class="card quote-doc-card quote-doc-last" x-data>
      <label>
        <strong>Quote notes</strong>
        <textarea class="desc-textarea" placeholder="Notes to the customer"
                  ${readOnly ? 'disabled' : ''}
                  @change="window._qPatch('notes_customer', $event.target.value)">${escape(quote.notes_customer ?? '')}</textarea>
      </label>

      <!-- ─── Step 3 — per-quote payment schedule editor ─────────
           Drives both the customer-facing Terms textarea below AND the
           Katana push milestone breakdown. Available on every quote
           type, every status (allowed on read-only via the patch
           route's READONLY_OVERRIDE_FIELDS). -->
      <div x-data="paymentScheduleEditor()" x-init="init()" style="margin-top:1rem;padding:.6rem .75rem;border:1px solid var(--border);border-radius:4px;background:var(--bg-elev)">
        <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;cursor:pointer;user-select:none"
             @click="collapsed = !collapsed"
             :title="collapsed ? 'Expand the payment schedule editor' : 'Collapse the payment schedule editor'">
          <span style="font-size:.75em;color:var(--fg-muted);width:1rem;display:inline-block;text-align:center"
                x-text="collapsed ? '▶' : '▼'"></span>
          <strong>Payment schedule</strong>
          <span class="muted" style="font-size:.8em" x-show="!collapsed">— milestone rows (% + weeks ARO + label). Saving rewrites the Terms text below and the Katana push milestones.</span>
          <span class="muted" style="font-size:.8em" x-show="collapsed" x-cloak>
            <span x-show="rows.length > 0" x-text="rows.length + ' row(s), ' + totalPct + '%'"></span>
            <span x-show="rows.length === 0">(empty — push falls back to site default)</span>
          </span>
        </div>
        <div x-show="!collapsed" x-cloak>
          <div class="muted" style="font-size:.75em;margin-top:.2rem">
            Use <code>{percent}</code> and <code>{weeks}</code>
          </div>


        <!-- Inline styles scoped to this table — keeps the editor's
             visual chrome lighter than the rest of the quote page. -->
        <style>
          .ps-editor input[type="number"], .ps-editor input[type="text"] {
            border: 1px solid #e5e5e5;
            border-radius: 3px;
            padding: 0.25rem 0.35rem;
          }
          .ps-editor input:focus { border-color: #b8b8b8; outline: none; }
          .ps-editor .ps-variant-select {
            background: transparent;
            border: none;
            border-bottom: 1px dashed #d8d8d8;
            border-radius: 0;
            color: var(--fg-muted);
            font-size: 0.78em;
            padding: 0.05rem 0.15rem;
            flex: 1;
            min-width: 0;
          }
          .ps-editor .ps-variant-select:hover { color: var(--fg); border-bottom-style: solid; }
          .ps-editor .ps-row-btn {
            border: none;
            background: transparent;
            color: #b0b0b0;
            cursor: pointer;
            padding: 0 0.2rem;
            font-size: 0.9em;
            line-height: 1;
          }
          .ps-editor .ps-row-btn:hover:not(:disabled) { color: var(--fg); }
          .ps-editor .ps-row-btn:disabled { color: #e0e0e0; cursor: default; }
          .ps-editor td { vertical-align: top; padding: 0.25rem 0.3rem; }
        </style>
        <table class="ps-editor" style="width:100%;font-size:.85rem;margin-top:.4rem;border-collapse:collapse">
          <thead>
            <tr>
              <th style="text-align:center;width:5rem">%</th>
              <th style="text-align:center;width:6rem">Weeks ARO</th>
              <th style="text-align:left">Label &amp; Katana variant</th>
              <th style="width:3.5rem"></th>
              <th style="width:1.75rem"></th>
            </tr>
          </thead>
          <tbody>
            <template x-for="(row, idx) in rows" :key="idx">
              <tr>
                <td><input type="number" min="0.01" max="100" step="0.01" x-model.number="row.percent" style="width:100%;text-align:right" ${readOnly ? 'disabled' : ''}></td>
                <td><input type="number" min="0" step="1" x-model="row.weeks" style="width:100%;text-align:right" placeholder="—" ${readOnly ? 'disabled' : ''}></td>
                <td>
                  <input type="text" x-model="row.label"
                         placeholder="e.g. Due {percent}% upon order confirmation, {weeks} weeks ARO"
                         style="width:100%" ${readOnly ? 'disabled' : ''}>
                  <div style="display:flex;align-items:center;gap:.3rem;margin-top:.15rem">
                    <span class="muted" style="font-size:.7em;flex-shrink:0">Katana:</span>
                    <select x-model.number="row.katana_variant_id"
                            @change="syncSku(row)"
                            class="ps-variant-select"
                            ${readOnly ? 'disabled' : ''}>
                      <option value="">— fallback —</option>
                      <template x-for="v in siteRows" :key="v.katana_variant_id">
                        <option :value="v.katana_variant_id" x-text="(v.katana_sku || ('#' + v.katana_variant_id)) + ' — ' + v.label"></option>
                      </template>
                    </select>
                    <!-- Subtle status chip — no green check; only surfaces
                         info when there's a fallback issue worth seeing. -->
                    <span x-show="!row.katana_variant_id && idx >= siteRows.length"
                          style="color:#b3261e;font-size:.7em;white-space:nowrap"
                          title="No fallback for this row position — push will block until you pick a variant.">&#9888; no fallback</span>
                  </div>
                </td>
                <td style="text-align:center;white-space:nowrap">
                  <button type="button" class="ps-row-btn" @click="moveUp(idx)"   :disabled="idx === 0" title="Move up" ${readOnly ? 'disabled' : ''}>&uarr;</button>
                  <button type="button" class="ps-row-btn" @click="moveDown(idx)" :disabled="idx === rows.length - 1" title="Move down" ${readOnly ? 'disabled' : ''}>&darr;</button>
                </td>
                <td style="text-align:center">
                  <button type="button" class="ps-row-btn" @click="removeRow(idx)" title="Remove row" ${readOnly ? 'disabled' : ''}>&times;</button>
                </td>
              </tr>
            </template>
            <tr x-show="rows.length === 0">
              <td colspan="5" class="muted" style="text-align:center;padding:.5rem;font-style:italic">No schedule set — push falls back to the site-default milestones at Settings &rarr; Katana milestones.</td>
            </tr>
            <tr x-show="rows.length > 0">
              <td style="text-align:center" :style="sumOk ? 'color:#1a7f37' : 'color:#b3261e'">
                <strong x-text="totalPct + '%'"></strong>
              </td>
              <td colspan="4" class="muted" style="font-size:.8em">
                <span x-show="sumOk">Sum = 100% ✓</span>
                <span x-show="!sumOk" style="color:#b3261e">Must equal 100%</span>
              </td>
            </tr>
          </tbody>
        </table>


        <div style="margin-top:.4rem;display:flex;gap:.4rem;flex-wrap:wrap;align-items:center">
          <button type="button" class="btn-tiny" @click="addRow()" ${readOnly ? 'disabled' : ''}>+ Add row</button>
          <!-- "Copy from <type> default" — uses the per-type default
               (migration 0075). Disabled when no type default exists yet. -->
          <button type="button" class="btn-tiny"
                  @click="copyFromTypeDefault()"
                  :disabled="!typeDefaultRows || typeDefaultRows.length === 0"
                  :title="(typeDefaultRows && typeDefaultRows.length > 0) ? ('Replace the current rows with the saved ' + typeLabel + ' default (' + typeDefaultRows.length + ' rows)') : ('No ' + typeLabel + ' default saved yet. Build a schedule, then "Set as default" to seed one.')"
                  ${readOnly ? 'disabled' : ''}
                  x-text="(typeDefaultRows && typeDefaultRows.length > 0) ? ('Copy from ' + typeLabel + ' default') : ('No ' + typeLabel + ' default yet')"></button>
          <button type="button" class="btn-tiny"
                  @click="copyFromSiteDefault()"
                  :disabled="siteRows.length === 0"
                  ${readOnly ? 'disabled' : ''}
                  title="Copy the raw milestone variants from Settings → Katana milestones. Useful as a starting point when no per-type default exists yet.">Copy from site map</button>
          <button type="button" class="btn primary small" @click="save()" :disabled="saving || (rows.length > 0 && !isValid)" x-text="saveLabel" ${readOnly ? 'disabled' : ''}></button>
          <!-- Admin only — saves current rows as the type's default. -->
          <span style="flex:1"></span>
          <button type="button" class="btn-tiny"
                  x-show="isAdmin"
                  @click="setAsTypeDefault()"
                  :disabled="saving || rows.length === 0 || !isValid"
                  :title="'Save these rows as the default schedule for all new ' + typeLabel + ' quotes'"
                  x-text="setDefaultLabel"
                  ${readOnly ? 'disabled' : ''}></button>
        </div>
        </div><!-- /x-show !collapsed -->
      </div>

      <!-- Step 6 — Fused 3-part Terms view. Visible when the payment
           schedule has rows; the legacy textarea takes over when it
           doesn't. The three segments (before, schedule readonly,
           after) persist independently — editing one never touches
           the others. Visually glued together so it reads as one
           cohesive block. -->
      <style>
        .terms-fused {
          border: 1px solid #d8d8d8;
          border-radius: 4px;
          overflow: hidden;
          background: var(--bg, white);
          margin-top: .3rem;
        }
        .terms-fused-seg {
          display: block;
          width: 100%;
          box-sizing: border-box;
          border: none;
          outline: none;
          padding: 0.45rem 0.6rem;
          font-family: inherit;
          font-size: 0.92rem;
          line-height: 1.45;
          background: transparent;
          margin: 0;
          color: inherit;
          resize: vertical;
        }
        .terms-fused-seg:focus { background: #fafafa; }
        .terms-fused-schedule {
          background: #f6f7f9;
          color: #444;
          border-top: 1px dashed #d8d8d8;
          border-bottom: 1px dashed #d8d8d8;
          white-space: pre-wrap;
          word-break: break-word;
          user-select: text;
          cursor: text;
        }
        .terms-fused-schedule:empty::before {
          content: '(no milestones — edit the Payment schedule above)';
          color: #999;
          font-style: italic;
        }
      </style>
      <div x-data="scheduledTerms()"
           x-show="$store.paymentSchedule && $store.paymentSchedule.hasRows"
           x-cloak
           style="margin-top:0.75rem">
        <strong>Terms</strong>
        <span class="muted" style="font-size:0.75em">— editable before/after, schedule middle is auto from the editor above</span>
        <div class="terms-fused">
          <textarea class="terms-fused-seg"
                    x-model="beforeText"
                    @change="saveBefore()"
                    placeholder="Type here for text BEFORE the milestone list. Leave blank if none."
                    rows="2"
                    ${readOnly ? 'disabled' : ''}></textarea>
          <pre class="terms-fused-seg terms-fused-schedule"
               x-text="$store.paymentSchedule.scheduleText"></pre>
          <textarea class="terms-fused-seg"
                    x-model="afterText"
                    @change="saveAfter()"
                    placeholder="Type here for text AFTER the milestone list. Leave blank if none."
                    rows="2"
                    ${readOnly ? 'disabled' : ''}></textarea>
        </div>
      </div>

      <!-- Legacy Terms view — shown only when no schedule rows.
           Wrapped in an x-data so x-show reacts to the store. -->
      <div x-data x-show="!$store.paymentSchedule || !$store.paymentSchedule.hasRows" x-cloak>
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
        : (quote.quote_type === 'spares' || quote.quote_type === 'service' || (quote.quote_type ?? '').startsWith('refurb_'))
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
      </div><!-- /legacy Terms x-show -->

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
    // Two-step confirm for deleting a quote. Reads line count and
    // identity off the form's data-* attributes (computed server-side).
    window.confirmDeleteQuote = function (form) {
      var num = form.dataset.quoteNumber || 'this quote';
      var rev = form.dataset.quoteRevision || '';
      var lineCount = parseInt(form.dataset.lineCount || '0', 10);
      var lineBit = lineCount > 0
        ? lineCount + ' line item' + (lineCount === 1 ? '' : 's')
        : 'no line items';
      var msg = 'Permanently delete ' + num + (rev ? ' ' + rev : '') + '?\\n\\n' +
                'This will also delete: ' + lineBit + '.\\n' +
                'Audit history is preserved.\\n\\n' +
                'This cannot be undone.';
      if (!confirm(msg)) return false;
      return confirm('Are you sure? Last chance.');
    };
    </script>
    <script>
    // AI line-polish handler. One delegated click listener finds any
    // [data-line-polish-id] button on the page and:
    //   1. POSTs the line id to the polish endpoint
    //   2. Server runs the line through Claude with the surrounding
    //      account / opp / quote-type context, returns
    //      { polished: { title, description, line_notes }, original }
    //   3. Confirms with the user (showing the diff in a textarea-like
    //      preview is overkill for a first pass — a plain confirm() is
    //      fine; the user can always Ctrl+Z / inline-edit afterward)
    //   4. Writes the polished values back into the line's three inputs
    //      and dispatches a 'change' event on each so the existing
    //      data-autosave wiring patches the row.
    document.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('[data-line-polish-id]');
      if (!btn) return;
      e.preventDefault();
      var lineId = btn.getAttribute('data-line-polish-id');
      if (!lineId) return;
      var row = btn.closest('tr[data-line-row]');
      if (!row) return;
      var titleInput = row.querySelector('input[name="title"]');
      var descInput  = row.querySelector('input[name="description"]');
      var notesArea  = row.querySelector('textarea[name="line_notes"]');
      btn.disabled = true;
      var origLabel = btn.innerHTML;
      btn.innerHTML = '<span style="font-size:0.8rem">Polishing…</span>';
      fetch('/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/lines/' + encodeURIComponent(lineId) + '/polish', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }).then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (j) {
          btn.disabled = false;
          btn.innerHTML = origLabel;
          if (!j || !j.ok) {
            alert('Polish failed: ' + ((j && j.error) || 'unknown error'));
            return;
          }
          var p = j.polished || {};
          var preview = '';
          if (titleInput && p.title != null && p.title !== titleInput.value) {
            preview += '\\n\\nTitle:\\n  ' + (titleInput.value || '(empty)') + '\\n  → ' + p.title;
          }
          if (descInput && p.description != null && p.description !== descInput.value) {
            preview += '\\n\\nDescription:\\n  ' + (descInput.value || '(empty)') + '\\n  → ' + p.description;
          }
          if (notesArea && p.line_notes != null && p.line_notes !== notesArea.value) {
            preview += '\\n\\nNotes:\\n  ' + (notesArea.value || '(empty)') + '\\n  → ' + p.line_notes;
          }
          if (!preview) {
            alert('Polish complete — no changes proposed (the AI thinks this line already reads cleanly).');
            return;
          }
          if (!confirm('Apply these AI-polished values to this line?' + preview)) return;
          // Apply each changed field and trigger change event so
          // data-autosave wiring patches the row.
          function setAndFire(el, val) {
            if (!el) return;
            el.value = val == null ? '' : String(val);
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
          if (titleInput && p.title != null) setAndFire(titleInput, p.title);
          if (descInput  && p.description != null) setAndFire(descInput,  p.description);
          if (notesArea  && p.line_notes != null) setAndFire(notesArea,  p.line_notes);
        })
        .catch(function (err) {
          btn.disabled = false;
          btn.innerHTML = origLabel;
          alert('Polish failed: ' + (err && err.message ? err.message : 'unknown error'));
        });
    });
    </script>
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
      // Step 6 — global store the schedule editor populates with
      // its current state. The fused Terms component (scheduledTerms)
      // reads { hasRows, scheduleText } to decide whether to render
      // its 3-part view vs hide in favor of the legacy textarea, and
      // to show the schedule preview in its middle band.
      Alpine.store('paymentSchedule', {
        hasRows: ${raw(JSON.stringify((quoteSchedule?.rows?.length || 0) > 0))},
        scheduleText: '', // schedule editor's broadcastRendered() fills this on init
      });

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

      // --- New Product default payment terms based on delivery weeks ---
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

      // Step 3 — bootstrap for the per-quote paymentScheduleEditor.
      // _initialPaymentSchedule is the saved JSON from quotes.payment_schedule
      // (null if never set). _siteMilestoneRows is the current site-wide
      // milestone map, used by the "Copy from site default" button on the
      // editor. _typeDefaultSchedule is the per-quote-type default from
      // migration 0075 (null when the type has no default yet).
      var _initialPaymentSchedule = ${raw(JSON.stringify(quoteSchedule || null))};
      var _siteMilestoneRows = ${raw(JSON.stringify(milestoneMap?.milestones || []))};
      var _typeDefaultSchedule = ${raw(JSON.stringify(typeDefaultSchedule || null))};
      var _typeLabel = ${raw(JSON.stringify(quote.quote_type || ''))};
      var _isAdminForDefaults = ${raw(JSON.stringify(user?.role === 'admin'))};
      // Step 6 — wrapper text around the schedule.
      var _initialPaymentTermsBefore = ${raw(JSON.stringify(quote.payment_terms_before || ''))};
      var _initialPaymentTermsAfter  = ${raw(JSON.stringify(quote.payment_terms_after  || ''))};

      // Admin-editable schedule from migration 0040. Mirrors the
      // server-side epsScheduleToString() renderer so draft quotes
      // stay in sync after admins change the schedule.
      var _epsSchedule = ${raw(JSON.stringify(epsSchedule || { rows: [] }))};
      function _fmtPct(p) {
        var n = Number(p);
        if (Number.isInteger(n)) return String(n);
        return n.toFixed(2).replace(/\\.?0+$/, '');
      }
      function epsDefaultTerms(weeks) {
        var rows = (_epsSchedule && _epsSchedule.rows) || [];
        if (rows.length === 0) return '';
        var needsWeeks = rows.some(function (r) { return r && r.weeks_num != null && r.weeks_den != null; });
        if (needsWeeks && (!weeks || weeks <= 0)) return '';
        return rows.map(function (r) {
          var label = String(r.label || '');
          if (r.weeks_num != null && r.weeks_den != null) {
            var n = parseInt(r.weeks_num, 10);
            var d = parseInt(r.weeks_den, 10);
            if (Number.isInteger(n) && Number.isInteger(d) && d > 0) {
              var w = Math.floor((n * weeks) / d);
              label = label.replace(/\\{weeks\\}/g, String(w));
            }
          }
          return _fmtPct(r.percent) + '% ' + label;
        }).join('\\n');
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

      // Step 3 — per-quote structured payment schedule editor.
      // Saves to quotes.payment_schedule (JSON). The patch route also
      // re-renders the schedule into quotes.payment_terms so the
      // customer-facing textarea below stays in sync with the rows.
      Alpine.data('paymentScheduleEditor', function() {
        function rowsFrom(src) {
          if (!src || !Array.isArray(src.rows)) return [];
          return src.rows.map(function(r) {
            return {
              percent: r.percent != null ? Number(r.percent) : 0,
              weeks: (r.weeks == null || r.weeks === '') ? '' : Number(r.weeks),
              label: String(r.label || ''),
              katana_variant_id: r.katana_variant_id != null ? Number(r.katana_variant_id) : '',
              katana_sku: String(r.katana_sku || ''),
            };
          });
        }
        var _baseline = JSON.stringify(_initialPaymentSchedule || null);
        return {
          rows: rowsFrom(_initialPaymentSchedule),
          siteRows: (_siteMilestoneRows || []).map(function(m) { return {
            percent: Number(m.percent) || 0, label: String(m.label || ''),
            weeks: '',
            katana_variant_id: Number(m.katana_variant_id) || '',
            katana_sku: String(m.katana_sku || ''),
          }; }),
          typeLabel: _typeLabel || '',
          isAdmin: !!_isAdminForDefaults,
          typeDefaultRows: _typeDefaultSchedule ? rowsFrom(_typeDefaultSchedule) : null,
          collapsed: false,
          saving: false,
          saveLabel: 'Save schedule',
          setDefaultLabel: 'Set as default',
          init: function() {
            var self = this;
            // Live-sync the schedule preview shown in the Terms area
            // (the scheduledTerms component below) as the user edits.
            // Mirrors lib/quote-payment-schedule.js scheduleToString().
            this.$watch('rows', function() { self.broadcastRendered(); }, { deep: true });
            this.broadcastRendered();
          },
          broadcastRendered: function() {
            // Update the global store so the Terms area's middle band
            // reflects schedule edits live. Schedule changes here do
            // NOT touch the user's before/after text — those live in
            // the scheduledTerms component, persisted separately.
            if (window.Alpine && Alpine.store && Alpine.store('paymentSchedule')) {
              Alpine.store('paymentSchedule').hasRows      = this.rows.length > 0;
              Alpine.store('paymentSchedule').scheduleText = this.scheduleText;
            }
          },
          get scheduleText() {
            function fmt(p) {
              var n = Number(p);
              if (!isFinite(n)) return '0';
              if (n === Math.floor(n)) return String(n);
              return n.toFixed(2).replace(/\\.?0+$/, '');
            }
            return this.rows.map(function(r) {
              var pct = fmt(r.percent);
              var w   = (r.weeks === '' || r.weeks == null) ? null : Number(r.weeks);
              var wStr = w == null ? '' : String(w);
              var label = String(r.label || '').trim();
              var hasP = label.indexOf('{percent}') >= 0;
              var hasW = label.indexOf('{weeks}') >= 0;
              if (hasP || hasW) {
                return label.replace(/\\{percent\\}/g, pct).replace(/\\{weeks\\}/g, wStr);
              }
              var out = pct + '% ' + label;
              if (w != null && w > 0 && !/week/i.test(label)) {
                out += ' ' + w + (w === 1 ? ' week' : ' weeks') + ' after Order Confirmation.';
              }
              return out;
            }).join('\\n');
          },
          get totalPct() {
            var s = 0;
            for (var i = 0; i < this.rows.length; i++) {
              var n = Number(this.rows[i].percent);
              if (Number.isFinite(n)) s += n;
            }
            return Math.round(s * 100) / 100;
          },
          get sumOk() {
            return Math.abs(this.totalPct - 100) < 0.01;
          },
          get isValid() {
            if (this.rows.length === 0) return false;
            if (!this.sumOk) return false;
            for (var i = 0; i < this.rows.length; i++) {
              var r = this.rows[i];
              var p = Number(r.percent);
              if (!Number.isFinite(p) || p <= 0 || p > 100) return false;
              if (!r.label || !String(r.label).trim()) return false;
            }
            return true;
          },
          get dirty() {
            return JSON.stringify(this._serialize()) !== _baseline;
          },
          _serializeSchedule: function() {
            if (this.rows.length === 0) return null;
            return {
              rows: this.rows.map(function(r) {
                var out = { percent: Number(r.percent), label: String(r.label).trim() };
                if (r.weeks !== '' && r.weeks != null) {
                  var w = Number(r.weeks);
                  if (Number.isFinite(w) && w >= 0) out.weeks = w;
                }
                if (r.katana_variant_id !== '' && r.katana_variant_id != null) {
                  var v = parseInt(r.katana_variant_id, 10);
                  if (Number.isFinite(v) && v > 0) out.katana_variant_id = v;
                }
                if (r.katana_sku) out.katana_sku = String(r.katana_sku).trim();
                return out;
              }),
            };
          },
          // Alias kept so callers can use either name.
          _serialize: function() { return this._serializeSchedule(); },
          addRow: function() {
            this.rows.push({ percent: 0, weeks: '', label: '', katana_variant_id: '', katana_sku: '' });
          },
          syncSku: function(row) {
            // When the user picks a variant from the dropdown, mirror
            // the SKU onto the row for at-a-glance display + so the
            // saved JSON carries it forward without another lookup.
            var match = this.siteRows.find(function(s) {
              return Number(s.katana_variant_id) === Number(row.katana_variant_id);
            });
            row.katana_sku = match ? match.katana_sku : '';
          },
          removeRow: function(idx) {
            this.rows.splice(idx, 1);
          },
          moveUp: function(idx) {
            if (idx <= 0) return;
            var tmp = this.rows[idx - 1];
            this.rows[idx - 1] = this.rows[idx];
            this.rows[idx] = tmp;
          },
          moveDown: function(idx) {
            if (idx >= this.rows.length - 1) return;
            var tmp = this.rows[idx + 1];
            this.rows[idx + 1] = this.rows[idx];
            this.rows[idx] = tmp;
          },
          copyFromSiteDefault: function() {
            if (this.rows.length > 0 && !confirm('Replace the current ' + this.rows.length + ' row(s) with the site default?')) return;
            this.rows = this.siteRows.map(function(m) {
              return {
                percent: m.percent, weeks: '', label: m.label,
                katana_variant_id: m.katana_variant_id, katana_sku: m.katana_sku,
              };
            });
          },
          copyFromTypeDefault: function() {
            if (!this.typeDefaultRows || this.typeDefaultRows.length === 0) {
              alert('No saved default for ' + (this.typeLabel || 'this quote type') + ' yet. Build a schedule first, then click "Set as default for this type" to save it.');
              return;
            }
            if (this.rows.length > 0 && !confirm('Replace the current ' + this.rows.length + ' row(s) with the saved ' + (this.typeLabel || 'type') + ' default?')) return;
            // Deep-copy so future edits on the editor don't mutate the
            // typeDefaultRows reference we hold in memory.
            this.rows = this.typeDefaultRows.map(function(r) {
              return {
                percent: Number(r.percent) || 0,
                weeks: r.weeks === '' || r.weeks == null ? '' : Number(r.weeks),
                label: String(r.label || ''),
                katana_variant_id: r.katana_variant_id === '' || r.katana_variant_id == null ? '' : Number(r.katana_variant_id),
                katana_sku: String(r.katana_sku || ''),
              };
            });
          },
          setAsTypeDefault: function() {
            if (!this.isAdmin) return;
            if (!this.isValid) {
              alert('Cannot save as default — the schedule must have at least one row and percentages must sum to 100.');
              return;
            }
            if (!confirm('Save this ' + this.rows.length + '-row schedule as the default for all new ' + (this.typeLabel || 'this type of') + ' quotes?\\n\\nExisting quotes are not retroactively updated.')) return;
            var self = this;
            self.saving = true;
            self.setDefaultLabel = 'Saving…';
            var payload = this._serialize();
            fetch('/quotes/payment-schedule-defaults', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ quote_type: self.typeLabel, schedule: payload }),
            }).then(function(r) { return r.json(); }).then(function(d) {
              self.saving = false;
              if (!d.ok) {
                self.setDefaultLabel = 'Set as default';
                alert('Could not save default: ' + (d.error || 'unknown error'));
                return;
              }
              // Update the in-memory typeDefaultRows so subsequent
              // "Copy from type default" reflects what we just saved
              // without a page reload.
              self.typeDefaultRows = (d.schedule && d.schedule.rows) ? d.schedule.rows.map(function(r) {
                return {
                  percent: Number(r.percent) || 0,
                  weeks: r.weeks == null || r.weeks === '' ? '' : Number(r.weeks),
                  label: String(r.label || ''),
                  katana_variant_id: r.katana_variant_id == null || r.katana_variant_id === '' ? '' : Number(r.katana_variant_id),
                  katana_sku: String(r.katana_sku || ''),
                };
              }) : null;
              self.setDefaultLabel = 'Saved as default ✓';
              setTimeout(function() { self.setDefaultLabel = 'Set as default'; }, 1800);
            }).catch(function(err) {
              self.saving = false;
              self.setDefaultLabel = 'Set as default';
              alert('Could not save default: ' + (err && err.message ? err.message : 'unknown error'));
            });
          },
          clearAll: function() {
            if (!confirm('Clear the entire schedule? The Katana push will fall back to the site default.')) return;
            this.rows = [];
            this.save(); // immediately persists null
          },
          discard: function() {
            this.rows = rowsFrom(_initialPaymentSchedule);
          },
          save: function() {
            var self = this;
            if (this.rows.length > 0 && !this.isValid) {
              alert('Schedule must have at least one row, every row needs a label and a percent > 0, and the percentages must sum to 100. Current sum: ' + this.totalPct);
              return;
            }
            self.saving = true;
            self.saveLabel = 'Saving…';
            var payload = this._serialize();
            // Schedule-only save. Before/after live in scheduledTerms
            // and persist via their own onChange handlers. Server-side
            // patch.js still recomputes payment_terms from whichever
            // pieces are in the request body, falling back to stored
            // values for the others.
            fetch('${raw(patchUrl)}', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ payment_schedule: payload }),
            }).then(function(r) { return r.json(); }).then(function(d) {
              self.saving = false;
              if (!d.ok) {
                self.saveLabel = 'Save schedule';
                alert('Save failed: ' + (d.error || 'unknown error'));
                return;
              }
              _baseline = JSON.stringify(payload);
              self.saveLabel = 'Saved ✓';
              setTimeout(function() { self.saveLabel = 'Save schedule'; }, 1500);
            }).catch(function(err) {
              self.saving = false;
              self.saveLabel = 'Save schedule';
              alert('Save failed: ' + (err && err.message ? err.message : 'unknown error'));
            });
          },
        };
      });

      // Step 6 — fused 3-part Terms editor used when the payment
      // schedule has rows. Before/after persist independently from
      // each other and from the schedule. The schedule preview in
      // the middle is read-only here; edit it in the Payment
      // schedule card above.
      Alpine.data('scheduledTerms', function() {
        return {
          beforeText: _initialPaymentTermsBefore || '',
          afterText:  _initialPaymentTermsAfter  || '',
          _beforeBaseline: _initialPaymentTermsBefore || '',
          _afterBaseline:  _initialPaymentTermsAfter  || '',
          saveBefore: function() {
            if (this.beforeText === this._beforeBaseline) return;
            this._beforeBaseline = this.beforeText;
            window._qPatch('payment_terms_before', this.beforeText);
          },
          saveAfter: function() {
            if (this.afterText === this._afterBaseline) return;
            this._afterBaseline = this.afterText;
            window._qPatch('payment_terms_after', this.afterText);
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
            // Step 3 — when the per-quote payment schedule editor
            // above broadcasts an update, mirror it into this
            // textarea so the user sees the doc-rendered text live.
            document.addEventListener('payment-schedule-rendered', function(e) {
              if (e.detail && e.detail.hasSchedule) {
                self._skipWatch = true;
                self.useDefault = false;
                self._skipWatch = false;
                self.termsVal = e.detail.text;
              }
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
            // Step 3 — sync from the per-quote payment schedule editor.
            document.addEventListener('payment-schedule-rendered', function(e) {
              if (e.detail && e.detail.hasSchedule) {
                self._skipWatch = true;
                self.useDefault = false;
                self._skipWatch = false;
                self.termsVal = e.detail.text;
              }
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
            // Step 3 — only payment_terms mirrors the schedule editor.
            // delivery_terms stays free-text.
            if (this.field === 'payment_terms') {
              document.addEventListener('payment-schedule-rendered', function(e) {
                if (e.detail && e.detail.hasSchedule) {
                  self._skipWatch = true;
                  self.useDefault = false;
                  self._skipWatch = false;
                  self.val = e.detail.text;
                }
              });
            }
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

      // Per-quote settings popover (gear icon in the quote header).
      // Currently one toggle — show/hide discount UI. Saves via _qPatch
      // and reloads so the server-rendered discount rows reflect the
      // new value immediately.
      Alpine.data('quoteSettings', function(initial) {
        return {
          open: false,
          value: !!initial,
          saving: false,
          save: function(next) {
            var self = this;
            self.value = !!next;
            self.saving = true;
            fetch('${raw(patchUrl)}', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ show_discounts: next ? 1 : 0 }),
            }).then(function(r) { return r.json(); }).then(function(d) {
              if (!d.ok) {
                self.value = !next;
                alert('Save failed: ' + (d.error || 'unknown error'));
                self.saving = false;
                return;
              }
              window.location.reload();
            }).catch(function(err) {
              self.value = !next;
              alert('Save failed: ' + err.message);
              self.saving = false;
            });
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
            // Sync the unit_price input to the server's authoritative
            // value. Lets the build-price fallback show up immediately
            // when the user clears the input (server resolved it to
            // the linked price build's quote_price_user). Skip when
            // the input is focused so we don't blow away in-progress
            // typing.
            if (typeof data.unit_price === 'number') {
              var priceInput = row.querySelector('[name="unit_price"]');
              if (priceInput && document.activeElement !== priceInput) {
                priceInput.value = String(data.unit_price);
              }
            }
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

      // ── Migration 0086 client wiring ─────────────────────────────
      //
      // 1. Group-selected button: enables once ≥2 checkboxes are
      //    ticked. Submitting reloads the page (server redirects after
      //    the group is created).
      // 2. Active toggle: POSTs the current line form with is_active
      //    flipped, then reloads so the row shows its new
      //    inactive/active treatment.
      // ---- Eye toggle (include/exclude) ----
      document.querySelectorAll('.line-active-toggle').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          var lineId = btn.getAttribute('data-line-id');
          var target = btn.getAttribute('data-target-active');
          var form = document.getElementById('line-form-' + lineId);
          if (!form) return;
          var hidden = form.querySelector('input[name="is_active"]');
          if (hidden) hidden.value = target;
          var fd = new FormData(form);
          fd.set('is_active', target);
          var scrollY = window.scrollY;
          sessionStorage.setItem('_scrollY', scrollY);
          fetch(form.action, {
            method: 'POST',
            headers: { 'accept': 'application/json' },
            body: fd,
          }).then(function() { window.location.reload(); })
            .catch(function(err) { console.error('Active toggle failed:', err); });
        });
      });

      // ---- Hover-only delete ----
      var deleteBaseUrl = '/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/lines/';
      document.querySelectorAll('.line-delete-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          if (!confirm('Delete this line?')) return;
          var lineId = btn.getAttribute('data-line-id');
          var tr = btn.closest('tr[data-line-row]');
          fetch(deleteBaseUrl + lineId + '/delete', {
            method: 'POST', credentials: 'same-origin',
            headers: { accept: 'application/json' },
          }).then(function(r) { return r.json(); })
            .then(function(j) {
              if (j.ok && tr) tr.remove();
              if (j.subtotal_price != null) {
                var el = document.getElementById('q-lines-subtotal');
                if (el) el.textContent = '$' + Number(j.subtotal_price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' subtotal';
              }
            })
            .catch(function() { location.reload(); });
        });
      });

      // ---- Drag-and-drop reordering ----
      var reorderUrl = '/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/lines/reorder';
      var dragSrcId = null;
      document.querySelectorAll('[data-drag-handle]').forEach(function(handle) {
        var tr = handle.closest('tr');
        if (!tr) return;
        tr.setAttribute('draggable', 'true');
        tr.addEventListener('dragstart', function(e) {
          dragSrcId = tr.getAttribute('data-line-id');
          tr.style.opacity = '0.4';
          e.dataTransfer.effectAllowed = 'move';
        });
        tr.addEventListener('dragend', function() { tr.style.opacity = ''; dragSrcId = null; clearHighlights(); });
        tr.addEventListener('dragover', function(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; tr.style.borderTop = '2px solid #3b82f6'; });
        tr.addEventListener('dragleave', function() { tr.style.borderTop = ''; });
        tr.addEventListener('drop', function(e) {
          e.preventDefault();
          tr.style.borderTop = '';
          var afterId = tr.getAttribute('data-line-id');
          if (!dragSrcId || dragSrcId === afterId) return;
          fetch(reorderUrl, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ lineId: dragSrcId, afterLineId: afterId }),
          }).then(function() { location.reload(); })
            .catch(function() { location.reload(); });
        });
      });
      function clearHighlights() {
        document.querySelectorAll('tr[data-line-row]').forEach(function(r) { r.style.borderTop = ''; });
      }

      // ---- Click-to-select + floating action bar ----
      var selected = new Set();
      var floatingBar = document.getElementById('line-floating-bar');
      var groupUrl = '/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/lines/group';
      document.querySelectorAll('[data-drag-handle]').forEach(function(handle) {
        handle.addEventListener('click', function(e) {
          if (e.detail > 1) return; // ignore double-click
          var lineId = handle.getAttribute('data-line-id');
          var tr = handle.closest('tr');
          if (selected.has(lineId)) { selected.delete(lineId); tr.classList.remove('line-selected'); }
          else { selected.add(lineId); tr.classList.add('line-selected'); }
          updateFloatingBar();
        });
      });
      function updateFloatingBar() {
        if (!floatingBar) return;
        var n = selected.size;
        floatingBar.hidden = n < 2;
        var groupBtn = floatingBar.querySelector('[data-action="group"]');
        var delBtn = floatingBar.querySelector('[data-action="delete"]');
        if (groupBtn) groupBtn.textContent = 'Group ' + n + ' lines';
        if (delBtn) delBtn.textContent = 'Delete ' + n + ' lines';
      }
      if (floatingBar) {
        floatingBar.querySelector('[data-action="group"]').addEventListener('click', function() {
          var ids = Array.from(selected);
          // Build the group note from selected lines' titles + descriptions.
          var note = [];
          ids.forEach(function(id) {
            var tr = document.querySelector('tr[data-line-id="' + id + '"]');
            if (!tr) return;
            var form = document.getElementById('line-form-' + id);
            if (!form) return;
            var t = (form.querySelector('[name="title"]') || {}).value || '';
            var d = (form.querySelector('[name="description"]') || {}).value || '';
            if (t || d) note.push((t + (d ? ' — ' + d : '')).trim());
          });
          var fd = new URLSearchParams();
          ids.forEach(function(id) { fd.append('line_ids', id); });
          fd.set('title', note[0] || 'Group');
          fd.set('line_notes', note.join('\\n'));
          fetch(groupUrl, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: fd.toString(),
          }).then(function() { location.reload(); });
        });
        floatingBar.querySelector('[data-action="delete"]').addEventListener('click', function() {
          if (!confirm('Delete ' + selected.size + ' lines?')) return;
          var ids = Array.from(selected);
          var done = 0;
          ids.forEach(function(id) {
            fetch(deleteBaseUrl + id + '/delete', {
              method: 'POST', credentials: 'same-origin',
              headers: { accept: 'application/json' },
            }).then(function() { done++; if (done >= ids.length) location.reload(); })
              .catch(function() { done++; if (done >= ids.length) location.reload(); });
          });
        });
      }
    })();
    </script>
  `;

  // AI Inbox in-context capture scripts (gated to wes.yoakum like the
  // /ai-inbox nav link). Loads the recorder + capture modal only when
  // the user actually has access to the feature.
  const captureScripts = (user && user.email === 'wes.yoakum@c-lars.com')
    ? html`<script defer src="/js/audio-recorder.js"></script><script defer src="/js/ai-capture.js"></script>`
    : '';

  // Phase 2c — Push-to-Katana modal lives at body root so it overlays
  // the page regardless of the trigger button's DOM position. Alpine
  // store ($store.katanaPush) wires the button in headerSection to
  // this modal.
  const katanaPushModal = katanaState.showSection
    ? html`
      <div x-data
           x-show="$store.katanaPush.modalOpen" x-cloak
           class="katana-push-modal-backdrop"
           @click.self="$store.katanaPush.closeModal()">
        <div class="katana-push-modal-panel" role="dialog" aria-labelledby="katana-push-title">
          <div class="katana-push-modal-header">
            <h2 id="katana-push-title" style="margin:0">Push to Katana</h2>
            <button type="button" class="katana-push-modal-close" @click="$store.katanaPush.closeModal()" :disabled="$store.katanaPush.busy" aria-label="Close">&times;</button>
          </div>
          <div class="katana-push-modal-body">
            <p class="muted" style="margin:0 0 .75rem">
              Creates <strong x-text="$store.katanaPush.pendingLineCount"></strong>
              Katana sales order(s), one per active quote line. Each SO
              has <strong x-text="$store.katanaPush.milestones.length"></strong>
              milestone rows (priced as the line's unit price &times; each
              milestone's percentage). Lines already pushed are skipped.
            </p>

            <table class="meta-table" style="width:100%;font-size:.9rem">
              <tbody>
                <tr>
                  <td style="width:8rem"><strong>Customer</strong></td>
                  <td>
                    <span x-text="$store.katanaPush.katanaCustomerName"></span>
                    <span class="muted" style="font-size:.85em">(Katana #<span x-text="$store.katanaPush.katanaCustomerId"></span>)</span>
                  </td>
                </tr>
                <tr>
                  <td><strong>Order # base</strong></td>
                  <td>
                    <input type="text" x-model="$store.katanaPush.orderNo" maxlength="60" style="width:100%">
                    <span class="muted" style="font-size:.75em">Per-line SOs append <code>-01</code>, <code>-02</code>, &hellip;</span>
                  </td>
                </tr>
                <tr>
                  <td><strong>Customer ref</strong></td>
                  <td><input type="text" x-model="$store.katanaPush.customerRef" maxlength="200" placeholder="optional &mdash; e.g. PO number (applied to every SO)" style="width:100%"></td>
                </tr>
                <tr>
                  <td><strong>Delivery date</strong></td>
                  <td>
                    <input type="date" x-model="$store.katanaPush.deliveryDate" style="width:auto">
                    <span class="muted" style="font-size:.75em">Optional &mdash; Katana defaults to +14 days when blank.</span>
                  </td>
                </tr>
                <tr>
                  <td style="vertical-align:top"><strong>Notes</strong></td>
                  <td><textarea x-model="$store.katanaPush.additionalInfo" rows="2" maxlength="2000" placeholder="optional &mdash; appended after the line label in Katana's additional_info" style="width:100%"></textarea></td>
                </tr>
              </tbody>
            </table>

            <!-- Lines preview — one row per quote line showing what will land in Katana. -->
            <h3 style="margin:1rem 0 .25rem">Lines (<span x-text="$store.katanaPush.lineCount"></span>)</h3>
            <table class="meta-table" style="width:100%;font-size:.85rem">
              <thead>
                <tr>
                  <th style="text-align:left;width:2.5rem">#</th>
                  <th style="text-align:left">Line</th>
                  <th style="text-align:right;width:4rem">Qty</th>
                  <th style="text-align:right;width:7rem">Unit $</th>
                  <th style="text-align:right;width:8rem">Total $</th>
                  <th style="text-align:left;width:14rem">Katana SO</th>
                </tr>
              </thead>
              <tbody>
                <template x-for="(line, idx) in $store.katanaPush.lines" :key="line.line_id">
                  <tr :style="line.already_pushed ? 'color:#1a7f37' : (line.push_error ? 'color:#b3261e' : '')">
                    <td x-text="line.idx"></td>
                    <td>
                      <span x-text="line.title"></span>
                      <span class="muted" style="font-size:.75em" x-show="line.part_number" x-text="' &mdash; P/N ' + line.part_number"></span>
                    </td>
                    <td style="text-align:right" x-text="line.quantity"></td>
                    <td style="text-align:right" x-text="'$' + line.unit_price.toFixed(2)"></td>
                    <td style="text-align:right" x-text="'$' + line.extended_price.toFixed(2)"></td>
                    <td>
                      <template x-if="line.already_pushed">
                        <span>&check; SO #<span x-text="line.katana_sales_order_id"></span></span>
                      </template>
                      <template x-if="!line.already_pushed && !line.push_error">
                        <span class="muted">&rarr; <code style="font-size:.75em" x-text="($store.katanaPush.orderNo || '') + '-' + String(line.idx).padStart(2, '0')"></code></span>
                      </template>
                      <template x-if="line.push_error">
                        <span x-text="line.push_error"></span>
                      </template>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>

            <!-- Milestone schedule — read-only display of the percentages
                 that will be applied per line. -->
            <h3 style="margin:1rem 0 .25rem">Milestone schedule (per line)</h3>
            <p class="muted" style="margin:0 0 .25rem;font-size:.85em">
              The same schedule is applied to every line. Edit at
              <a href="/settings/katana-milestones" target="_blank">Settings &rarr; Katana milestones</a>.
            </p>
            <table class="meta-table" style="width:100%;font-size:.85rem">
              <thead>
                <tr>
                  <th style="text-align:right;width:4rem">%</th>
                  <th style="text-align:left">Label</th>
                  <th style="text-align:left;width:14rem">Katana variant</th>
                </tr>
              </thead>
              <tbody>
                <template x-for="(m, idx) in $store.katanaPush.milestones" :key="idx">
                  <tr>
                    <td style="text-align:right" x-text="m.percent"></td>
                    <td x-text="m.label"></td>
                    <td>
                      <code style="font-size:.8em" x-text="m.katana_sku"></code>
                      <span class="muted" style="font-size:.75em">#<span x-text="m.katana_variant_id"></span></span>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>

            <!-- Last push result summary — shows up after a push so the
                 user can see what succeeded vs. what errored without
                 closing the modal. -->
            <div x-show="$store.katanaPush.lastPushResult" x-cloak style="margin-top:1rem;padding:.5rem .75rem;background:var(--bg-elev);border:1px solid var(--border);border-radius:4px;font-size:.85rem">
              <strong>Last push:</strong>
              <span style="color:#1a7f37" x-show="$store.katanaPush.lastPushResult && $store.katanaPush.lastPushResult.pushed_count">
                &check; <span x-text="$store.katanaPush.lastPushResult && $store.katanaPush.lastPushResult.pushed_count"></span> line(s) pushed
              </span>
              <span class="muted" x-show="$store.katanaPush.lastPushResult && $store.katanaPush.lastPushResult.skipped_count">
                &middot; <span x-text="$store.katanaPush.lastPushResult && $store.katanaPush.lastPushResult.skipped_count"></span> skipped
              </span>
              <span style="color:#b3261e" x-show="$store.katanaPush.lastPushResult && $store.katanaPush.lastPushResult.error_count">
                &middot; <span x-text="$store.katanaPush.lastPushResult && $store.katanaPush.lastPushResult.error_count"></span> error(s)
              </span>
            </div>
          </div>
          <div class="katana-push-modal-footer">
            <button type="button" class="btn" @click="$store.katanaPush.closeModal()" :disabled="$store.katanaPush.busy">Close</button>
            <button type="button" class="btn primary"
                    @click="$store.katanaPush.push()"
                    :disabled="$store.katanaPush.busy || $store.katanaPush.pendingLineCount === 0"
                    x-text="$store.katanaPush.busy ? 'Pushing…' : ('Push ' + ($store.katanaPush.pendingLineCount || 0) + ' line(s) to Katana')"></button>
          </div>
        </div>
      </div>
      <script>window.__KATANA_PUSH_STATE__ = ${raw(katanaStateJson)};</script>
      <script>${raw(KATANA_PUSH_SCRIPT)}</script>
    `
    : '';

  const libraryModal = !readOnly ? html`
    <style>
      .line-delete-btn{opacity:0;transition:opacity .15s;background:transparent;border:0;color:var(--muted);font-size:1.1em;cursor:pointer;padding:.1rem .3rem;border-radius:3px}
      tr[data-line-row]:hover .line-delete-btn{opacity:1}
      .line-delete-btn:hover{color:#cf222e;background:#fff0f0}
      .line-eye-toggle{background:transparent;border:0;cursor:pointer;padding:.1rem;color:var(--muted);opacity:.5;transition:opacity .15s}
      tr[data-line-row]:hover .line-eye-toggle{opacity:1}
      .line-build-icon{opacity:.3;transition:opacity .15s}
      tr[data-line-row]:hover .line-build-icon{opacity:1}
      tr.line-selected{background:#eef2ff !important;outline:2px solid #3b82f6;outline-offset:-2px}
      .col-handle:active{cursor:grabbing}
      #line-floating-bar{position:fixed;bottom:1.5rem;left:50%;transform:translateX(-50%);background:#1e293b;color:#fff;padding:.5rem 1.2rem;border-radius:8px;display:flex;gap:.75rem;align-items:center;box-shadow:0 4px 20px rgba(0,0,0,.25);z-index:50;font-size:.85rem}
      #line-floating-bar[hidden]{display:none}
      #line-floating-bar button{background:transparent;border:1px solid rgba(255,255,255,.3);color:#fff;padding:.3rem .7rem;border-radius:4px;cursor:pointer;font-size:.82rem}
      #line-floating-bar button:hover{background:rgba(255,255,255,.15)}
      #line-floating-bar button[data-action="delete"]{border-color:#ef4444;color:#fca5a5}
      #line-floating-bar button[data-action="delete"]:hover{background:#ef4444;color:#fff}
    </style>
    <div id="line-floating-bar" hidden>
      <button type="button" data-action="group">Group lines</button>
      <button type="button" data-action="delete">Delete lines</button>
    </div>
    <dialog id="library-search-modal" style="max-width:600px;width:90%;border:1px solid var(--border,#d8d8d8);border-radius:8px;padding:1.2rem">
      <form method="dialog" style="margin:0">
        <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem">
          <h3 style="margin:0;font-size:1rem">Add from library</h3>
          <span style="flex:1"></span>
          <button type="submit" class="btn small">Close</button>
        </div>
      </form>
      <input type="text" id="lib-search-input" placeholder="Search by part #, name, or description..."
             style="width:100%;padding:.4rem .6rem;font-size:.9rem;border:1px solid var(--border);border-radius:4px;margin-bottom:.5rem"
             autocomplete="off">
      <div id="lib-search-results" style="max-height:350px;overflow-y:auto"></div>
    </dialog>
    <dialog id="import-lines-modal" style="max-width:800px;width:95%;border:1px solid var(--border,#d8d8d8);border-radius:8px;padding:1.2rem">
      <form method="dialog" style="margin:0">
        <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem">
          <h3 style="margin:0;font-size:1rem">Import line items from file</h3>
          <span style="flex:1"></span>
          <button type="submit" class="btn small">Close</button>
        </div>
      </form>
      <div id="import-dropzone"
           style="border:2px dashed var(--border,#d8d8d8);border-radius:8px;padding:2rem;text-align:center;cursor:pointer;transition:border-color .15s,background .15s;margin-bottom:.5rem"
           ondragover="event.preventDefault();this.style.borderColor='#3b82f6';this.style.background='#eef2ff'"
           ondragleave="this.style.borderColor='';this.style.background=''"
           ondrop="event.preventDefault();this.style.borderColor='';this.style.background='';var f=event.dataTransfer.files[0];if(f){document.getElementById('import-file-input').files=event.dataTransfer.files;document.getElementById('import-file-input').dispatchEvent(new Event('change'))}"
           onclick="document.getElementById('import-file-input').click()">
        <div style="font-size:1.5rem;margin-bottom:.3rem;color:var(--muted,#999)">&#8593;</div>
        <div style="font-size:.9rem;font-weight:500">Drop a file here or click to browse</div>
        <div class="muted" style="font-size:.78rem;margin-top:.25rem">CSV, Excel, PDF, Word, image — any format</div>
      </div>
      <input type="file" id="import-file-input"
             accept=".csv,.tsv,.xlsx,.xls,.pdf,.docx,.doc,.txt,.png,.jpg,.jpeg,.gif,.webp"
             style="display:none">
      <p id="import-status" hidden class="muted" style="font-size:.85rem"></p>
      <div id="import-preview" style="max-height:400px;overflow-y:auto"></div>
      <button type="button" id="import-confirm-btn" class="btn primary" hidden style="margin-top:.5rem"></button>
    </dialog>
    <style>
      .lib-result{padding:.5rem .6rem;border-bottom:1px solid #f0f0f0;cursor:pointer;display:grid;grid-template-columns:1fr auto;gap:.5rem;align-items:center}
      .lib-result:hover{background:#f5f5f7}
      .lib-result-name{font-weight:600;font-size:.85rem}
      .lib-result-meta{font-size:.78rem;color:var(--muted,#666)}
      .lib-result-price{font-size:.85rem;font-weight:500;text-align:right}
      .lib-result-btn{font-size:.75rem}
    </style>
    <script>
    (function(){
      var modal = document.getElementById('library-search-modal');
      var input = document.getElementById('lib-search-input');
      var results = document.getElementById('lib-search-results');
      if (!modal || !input || !results) return;
      var timer = null;
      var addUrl = '/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/lines';

      input.addEventListener('input', function(){
        clearTimeout(timer);
        var q = input.value.trim();
        if (q.length < 2) { results.innerHTML = '<p class="muted" style="padding:.5rem">Type at least 2 characters…</p>'; return; }
        timer = setTimeout(function(){
          fetch('/api/items-library-search?q=' + encodeURIComponent(q) + '&limit=20', { credentials: 'same-origin' })
            .then(function(r){ return r.json(); })
            .then(function(items){
              if (!items.length) { results.innerHTML = '<p class="muted" style="padding:.5rem">No matches.</p>'; return; }
              results.innerHTML = items.map(function(it){
                var price = it.default_price ? '$' + Number(it.default_price).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}) : '';
                var meta = [it.part_number, it.item_type, it.default_unit, it.use_count ? it.use_count + ' uses' : ''].filter(Boolean).join(' · ');
                return '<div class="lib-result" data-lib-id="' + it.id + '">' +
                  '<div><div class="lib-result-name">' + esc(it.name) + '</div>' +
                  '<div class="lib-result-meta">' + esc(meta) + '</div>' +
                  (it.description ? '<div class="lib-result-meta">' + esc(it.description.slice(0, 100)) + '</div>' : '') +
                  '</div>' +
                  '<div style="text-align:right"><div class="lib-result-price">' + esc(price) + '</div>' +
                  '<button type="button" class="btn small primary lib-result-btn" data-lib-json=\\'' + JSON.stringify(it).replace(/'/g, '&#39;') + '\\'>Add</button></div></div>';
              }).join('');
            })
            .catch(function(){ results.innerHTML = '<p class="muted" style="padding:.5rem">Search failed.</p>'; });
        }, 250);
      });

      function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

      results.addEventListener('click', function(e){
        var btn = e.target.closest('[data-lib-json]');
        if (!btn) return;
        var it = JSON.parse(btn.getAttribute('data-lib-json'));
        btn.disabled = true;
        btn.textContent = 'Adding…';
        var body = new URLSearchParams();
        body.set('title', it.name || '');
        body.set('part_number', it.part_number || '');
        body.set('description', it.description || '');
        body.set('item_type', it.item_type || 'product');
        body.set('unit', it.default_unit || 'ea');
        body.set('unit_price', String(it.default_price || 0));
        body.set('quantity', '1');
        body.set('notes', it.item_notes || '');
        fetch(addUrl, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: body.toString()
        }).then(function(r){ return r.json(); })
          .then(function(j){
            if (j.ok) { btn.textContent = 'Added'; setTimeout(function(){ location.reload(); }, 300); }
            else { btn.textContent = 'Error'; btn.disabled = false; }
          })
          .catch(function(){ btn.textContent = 'Error'; btn.disabled = false; });
      });

      modal.addEventListener('close', function(){ input.value = ''; results.innerHTML = ''; });
    })();
    </script>
    <style>
      .typeahead-dropdown{position:absolute;z-index:100;background:#fff;border:1px solid var(--border,#d8d8d8);border-radius:4px;box-shadow:0 4px 12px rgba(0,0,0,.12);max-height:220px;overflow-y:auto;width:100%;left:0;top:100%}
      .typeahead-dropdown[hidden]{display:none}
      .ta-item{padding:.35rem .5rem;cursor:pointer;font-size:.82rem;border-bottom:1px solid #f5f5f5}
      .ta-item:hover,.ta-item.ta-active{background:#eef2ff}
      .ta-item-name{font-weight:600}
      .ta-item-meta{font-size:.75rem;color:var(--muted,#666)}
    </style>
    <script>
    (function(){
      var inputs = document.querySelectorAll('input[data-typeahead="library"]');
      if (!inputs.length) return;
      function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

      inputs.forEach(function(inp){
        var wrap = inp.parentNode;
        if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
        var dd = document.createElement('div');
        dd.className = 'typeahead-dropdown';
        dd.hidden = true;
        wrap.appendChild(dd);
        var timer = null;
        var activeIdx = -1;

        inp.addEventListener('input', function(){
          clearTimeout(timer);
          var q = inp.value.trim();
          if (q.length < 2) { dd.hidden = true; return; }
          timer = setTimeout(function(){
            fetch('/api/items-library-search?q=' + encodeURIComponent(q) + '&limit=8', { credentials: 'same-origin' })
              .then(function(r){ return r.json(); })
              .then(function(items){
                if (!items.length) { dd.hidden = true; return; }
                activeIdx = -1;
                dd.innerHTML = items.map(function(it, i){
                  var meta = [it.part_number, it.default_unit, it.default_price ? '$' + Number(it.default_price).toFixed(2) : ''].filter(Boolean).join(' · ');
                  return '<div class="ta-item" data-idx="' + i + '" data-json="' + esc(JSON.stringify(it)) + '"><span class="ta-item-name">' + esc(it.name) + '</span> <span class="ta-item-meta">' + esc(meta) + '</span></div>';
                }).join('');
                dd.hidden = false;
              })
              .catch(function(){ dd.hidden = true; });
          }, 200);
        });

        dd.addEventListener('click', function(e){
          var el = e.target.closest('.ta-item');
          if (!el) return;
          applyItem(inp, JSON.parse(el.getAttribute('data-json')));
          dd.hidden = true;
        });

        inp.addEventListener('keydown', function(e){
          if (dd.hidden) return;
          var items = dd.querySelectorAll('.ta-item');
          if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, items.length - 1); highlight(items); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); highlight(items); }
          else if (e.key === 'Enter' && activeIdx >= 0 && items[activeIdx]) {
            e.preventDefault();
            applyItem(inp, JSON.parse(items[activeIdx].getAttribute('data-json')));
            dd.hidden = true;
          }
          else if (e.key === 'Escape') { dd.hidden = true; }
        });

        function highlight(items){
          items.forEach(function(el, i){ el.classList.toggle('ta-active', i === activeIdx); });
          if (items[activeIdx]) items[activeIdx].scrollIntoView({ block: 'nearest' });
        }

        inp.addEventListener('blur', function(){ setTimeout(function(){ dd.hidden = true; }, 150); });
      });

      // ---- Import Lines Modal ----
      var importModal = document.getElementById('import-lines-modal');
      var importInput = document.getElementById('import-file-input');
      var importStatus = document.getElementById('import-status');
      var importPreview = document.getElementById('import-preview');
      var importConfirmBtn = document.getElementById('import-confirm-btn');
      var importUrl = '/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/import-lines';
      var addLinesUrl = '/opportunities/${escape(oppId)}/quotes/${escape(quoteId)}/lines';
      var importedLines = [];

      if (importInput) {
        importInput.addEventListener('change', function(){
          var file = importInput.files[0];
          if (!file) return;
          importStatus.hidden = false;
          importPreview.innerHTML = '';
          importConfirmBtn.hidden = true;
          // Animated progress messages to keep the user engaged.
          var steps = [
            'Uploading file...',
            'Reading document...',
            'Extracting text...',
            'Identifying line items with AI...',
            'Almost there...',
          ];
          var stepIdx = 0;
          importStatus.textContent = steps[0];
          var stepTimer = setInterval(function(){
            stepIdx++;
            if (stepIdx < steps.length) importStatus.textContent = steps[stepIdx];
          }, 4000);
          var fd = new FormData();
          fd.append('file', file);
          fetch(importUrl, { method: 'POST', credentials: 'same-origin', body: fd })
            .then(function(r){ return r.json(); })
            .then(function(j){
              clearInterval(stepTimer);
              importStatus.hidden = true;
              if (!j.ok || !j.lines || !j.lines.length) {
                importStatus.textContent = j.error || 'No line items found in the file.';
                importStatus.hidden = false;
                return;
              }
              importedLines = j.lines;
              renderImportPreview();
            })
            .catch(function(e){
              clearInterval(stepTimer);
              importStatus.textContent = 'Failed: ' + (e.message || e);
              importStatus.hidden = false;
            });
        });
      }

      function renderImportPreview(){
        if (!importedLines.length) { importPreview.innerHTML = '<p class="muted">No lines.</p>'; importConfirmBtn.hidden = true; return; }
        var html = '<table class="data compact" style="font-size:.82rem;width:100%"><thead><tr><th>Part #</th><th>Title</th><th>Desc</th><th>Qty</th><th>Unit</th><th>Price</th><th>Notes</th><th></th></tr></thead><tbody>';
        importedLines.forEach(function(l, i){
          html += '<tr data-import-idx="' + i + '">' +
            '<td><input type="text" value="' + esc(l.part_number) + '" data-field="part_number" style="width:80px"></td>' +
            '<td><input type="text" value="' + esc(l.title) + '" data-field="title" style="width:120px"></td>' +
            '<td><input type="text" value="' + esc(l.description) + '" data-field="description" style="width:150px"></td>' +
            '<td><input type="number" value="' + (l.quantity||1) + '" data-field="quantity" style="width:50px"></td>' +
            '<td><input type="text" value="' + esc(l.unit||'ea') + '" data-field="unit" style="width:40px"></td>' +
            '<td><input type="number" value="' + (l.unit_price!=null?l.unit_price:'') + '" data-field="unit_price" style="width:70px" step="0.01"></td>' +
            '<td><input type="text" value="' + esc(l.notes) + '" data-field="notes" style="width:100px"></td>' +
            '<td><button type="button" class="row-delete-btn" onclick="removeImportLine(' + i + ')" title="Remove">&times;</button></td></tr>';
        });
        html += '</tbody></table>';
        importPreview.innerHTML = html;
        importConfirmBtn.hidden = false;
        importConfirmBtn.textContent = 'Add ' + importedLines.length + ' line(s) to quote';
      }
      window.removeImportLine = function(idx){
        importedLines.splice(idx, 1);
        renderImportPreview();
      };

      if (importConfirmBtn) {
        importConfirmBtn.addEventListener('click', function(){
          // Read edited values from the preview table
          var rows = importPreview.querySelectorAll('tr[data-import-idx]');
          var lines = [];
          rows.forEach(function(tr){
            var line = {};
            tr.querySelectorAll('input').forEach(function(inp){
              line[inp.getAttribute('data-field')] = inp.value;
            });
            lines.push(line);
          });
          if (!lines.length) return;
          importConfirmBtn.disabled = true;
          importConfirmBtn.textContent = 'Adding...';
          var pending = lines.length;
          var done = 0;
          lines.forEach(function(l){
            var body = new URLSearchParams();
            body.set('title', l.title || '');
            body.set('part_number', l.part_number || '');
            body.set('description', l.description || '');
            body.set('quantity', l.quantity || '1');
            body.set('unit', l.unit || 'ea');
            body.set('unit_price', l.unit_price || '0');
            body.set('notes', l.notes || '');
            body.set('item_type', 'product');
            fetch(addLinesUrl, {
              method: 'POST', credentials: 'same-origin',
              headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
              body: body.toString()
            }).then(function(){ done++; if (done >= pending) location.reload(); })
              .catch(function(){ done++; if (done >= pending) location.reload(); });
          });
        });
      }

      if (importModal) {
        importModal.addEventListener('close', function(){
          importInput.value = '';
          importStatus.hidden = true;
          importPreview.innerHTML = '';
          importConfirmBtn.hidden = true;
          importedLines = [];
        });
      }

      function applyItem(inp, it){
        var form = inp.closest('form');
        if (!form) return;
        inp.value = it.name || '';
        var desc = form.querySelector('[name="description"]');
        var unit = form.querySelector('[name="unit"]');
        var price = form.querySelector('[name="unit_price"]');
        var qty = form.querySelector('[name="quantity"]');
        if (desc && !desc.value && it.description) desc.value = it.description;
        if (unit && it.default_unit) unit.value = it.default_unit;
        if (price && it.default_price) price.value = it.default_price;
        // Trigger autosave on each field
        [inp, desc, unit, price].forEach(function(el){
          if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
        });
      }
    })();
    </script>
  ` : '';

  const body = html`${headerSection}<div class="quote-doc">${bannerCard}${detailsSection}${linesSection}${footerSection}</div>${katanaPushModal}${libraryModal}${scripts}${captureScripts}`;

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
  // Total columns to span before the "amount" column. Editable mode has
  // an Actions column inserted between # and Item (migration 0086), so
  // the label spans one extra cell.
  const labelSpan = readOnly ? 5 : 6;
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
        <td colspan="${labelSpan}" class="num"><em>${escape(descVal || 'Discount')}</em></td>
        <td class="num"><em>-${fmtDollar(headerDiscountApplied)}</em></td>
        <td></td>
      </tr>
    `;
  }

  // Editable rendering: inline inputs for description / amount / pct / phantom.
  return html`
    <tr class="totals-row discount-row" x-data="quoteDiscount()">
      <td colspan="${labelSpan}" class="num" style="text-align:right">
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
