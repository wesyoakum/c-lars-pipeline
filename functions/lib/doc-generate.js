// functions/lib/doc-generate.js
//
// Core document generation: loads quote data, fills a docxtemplater
// template from R2, and optionally converts .docx → PDF via ConvertAPI.

import { one, all } from './db.js';
import {
  fmtDollar,
  computeDiscountApplied,
  readDiscountFromRow,
  computePhantomMarkup,
} from './pricing.js';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import {
  TEMPLATE_CATALOG,
  templateTypeForQuote,
  fallbackTemplateTypeForQuote,
  templateTypeForOC,
} from './template-catalog.js';
import {
  parseQuoteTypes,
  isHybridQuote,
  QUOTE_TYPE_LABELS,
} from './validators.js';

// ── Template key mapping ────────────────────────────────────────────

export function templateKeyForQuote(quoteType, opts = {}) {
  const catKey = templateTypeForQuote(quoteType, opts);
  return TEMPLATE_CATALOG[catKey]?.r2Key || 'templates/quote-spares.docx';
}

/**
 * T3.4 Sub-feature A — resolve a quote_type to an R2 template key with
 * graceful fallback. For hybrid quotes we first try the dedicated
 * `quote-hybrid.docx` template, and if that doesn't exist yet (because
 * Wes hasn't uploaded the real template), fall back to the primary
 * type's single-type template so the quote still generates. This
 * keeps the feature usable before the template lands.
 *
 * Returns an object: { key, usedFallback: boolean, primaryKey }.
 */
export async function resolveQuoteTemplateKey(env, quoteType, opts = {}) {
  const primaryKey = templateKeyForQuote(quoteType, opts);
  // Change-order quotes always use the single `quote-change-order`
  // template regardless of quote_type — no hybrid fallback needed.
  if (opts.isChangeOrder) {
    return { key: primaryKey, usedFallback: false, primaryKey };
  }
  if (!isHybridQuote(quoteType)) {
    return { key: primaryKey, usedFallback: false, primaryKey };
  }
  // Hybrid — probe R2 to see if the hybrid template exists.
  try {
    const head = await env.DOCS.head(primaryKey);
    if (head) {
      return { key: primaryKey, usedFallback: false, primaryKey };
    }
  } catch {
    // fall through to fallback
  }
  const fallbackCatKey = fallbackTemplateTypeForQuote(quoteType);
  const fallbackKey = TEMPLATE_CATALOG[fallbackCatKey]?.r2Key
    || 'templates/quote-spares.docx';
  return { key: fallbackKey, usedFallback: true, primaryKey };
}

/**
 * Resolve the R2 key for an Order Confirmation template, keyed by
 * job type. Mirrors resolveQuoteTemplateKey but without the hybrid-
 * fallback complication — every job type has its own OC template.
 */
export async function resolveOcTemplateKey(env, jobType) {
  const catKey = templateTypeForOC(jobType);
  const r2Key =
    TEMPLATE_CATALOG[catKey]?.r2Key || 'templates/oc-spares.docx';
  return { key: r2Key, catalogKey: catKey };
}

// ── Load quote data ─────────────────────────────────────────────────

/**
 * Load all the data needed to populate a quote document template.
 * Returns a flat object whose keys match the docxtemplater placeholders.
 */
export async function getQuoteDocData(env, quoteId) {
  const quote = await one(
    env.DB,
    `SELECT q.*, o.number AS opp_number,
            o.account_id,
            o.title AS opp_title,
            o.customer_po_number,
            a.name AS account_name,
            a.alias AS account_alias,
            c.first_name AS contact_first, c.last_name AS contact_last,
            c.email AS contact_email, c.phone AS contact_phone,
            c.title AS contact_title
       FROM quotes q
       LEFT JOIN opportunities o ON o.id = q.opportunity_id
       LEFT JOIN accounts a      ON a.id = o.account_id
       LEFT JOIN contacts c      ON c.id = o.primary_contact_id
      WHERE q.id = ?`,
    [quoteId]
  );
  if (!quote) return null;

  // Billing address (prefer selected, then default billing, then first available)
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

  // 'both' rows count as billing too.
  const isBilling = (a) => a.kind === 'billing' || a.kind === 'both';
  const billingAddr = addresses.find(a => a.id === quote.billing_address_id)
    || addresses.find(a => isBilling(a) && a.is_default)
    || addresses.find(a => isBilling(a))
    || addresses[0];

  // Line items
  const lines = await all(
    env.DB,
    `SELECT * FROM quote_lines
      WHERE quote_id = ?
      ORDER BY sort_order, id`,
    [quoteId]
  );

  // Split into regular lines vs option lines (refurb)
  const regularLines = lines.filter(l => !l.is_option);
  const optionLines = lines.filter(l => l.is_option);

  // Format date for display
  const fmtDate = (iso) => {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      });
    } catch { return iso; }
  };

  // Format dollar amounts for line items.
  //
  // T3.2 Phase 2 — Line-level discounts:
  //   - REAL line discounts are baked into stored `extended_price`, so the
  //     displayed amount column shows the post-discount figure. Templates
  //     that want to surface the original pre-discount price can use
  //     `lineGrossAmount` alongside `lineDiscountAmount` /
  //     `lineDiscountDescription`. The subtotal displayed on the PDF
  //     already ties out because the amount column is the stored value.
  //   - PHANTOM line discounts are a no-op at storage time. At render
  //     time we mark up unit_price + amount so the PDF shows a "list
  //     price" that, after a corresponding discount line (aggregated in
  //     `quoteDiscountAmount`), returns to the real net.
  //
  // We also track `_phantomMarkupDelta` (raw number, not formatted) so
  // the outer function can aggregate all line phantom markups into the
  // header discount figure.
  const fmtLine = (line) => {
    const qty = Number(line.quantity) || 0;
    const lineDiscount = readDiscountFromRow(line);
    const realNet = Number(line.extended_price) || 0;

    // Default: display = stored (works for no-discount and real-discount lines)
    let displayUnitPrice = Number(line.unit_price) || 0;
    let displayAmount = realNet;
    let lineDiscountApplied = 0;
    let phantomMarkupDelta = 0;
    // lineGrossAmount = pre-discount "list price" figure for templates
    // that want to show "was X" alongside "net Y".
    let lineGrossAmount = realNet;

    if (lineDiscount && lineDiscount.isPhantom) {
      // Phantom markup — mark up unit_price + displayed amount so the
      // aggregate discount row returns to the real net. realNet here is
      // qty × unit_price (phantom is a no-op at storage, so the stored
      // extended equals qty × stored unit price).
      const { grossDisplay, discountApplied } = computePhantomMarkup(
        lineDiscount,
        realNet
      );
      displayAmount = grossDisplay;
      displayUnitPrice = qty > 0 ? grossDisplay / qty : displayUnitPrice;
      lineDiscountApplied = discountApplied;
      phantomMarkupDelta = discountApplied;
      lineGrossAmount = grossDisplay;
    } else if (lineDiscount) {
      // Real discount — the stored extended_price is already
      // post-discount, so displayAmount (=realNet) is what the PDF
      // shows in the amount column. We expose the pre-discount figure
      // in `lineGrossAmount` so templates can render a secondary
      // "was X" note.
      const preDiscount = qty * displayUnitPrice;
      const applied = computeDiscountApplied(lineDiscount, preDiscount);
      if (applied > 0) {
        lineDiscountApplied = applied;
        lineGrossAmount = preDiscount;
      }
    }

    return {
      title: line.title || line.description || '',
      note: line.notes || line.line_notes || '',
      partNumber: line.part_number || '',
      quantity: line.quantity != null ? String(line.quantity) : '',
      unit: line.unit || '',
      unitPrice: fmtDollar(displayUnitPrice),
      amount: fmtDollar(displayAmount),
      lineItemType: line.item_type || '',

      // Line discount metadata (empty / 0 when no line-level discount)
      hasLineDiscount: lineDiscountApplied > 0 ||
        !!(lineDiscount && lineDiscount.description),
      lineDiscountDescription: lineDiscount?.description || '',
      lineDiscountAmount: fmtDollar(lineDiscountApplied),
      lineGrossAmount: fmtDollar(lineGrossAmount),
      lineNetAmount: fmtDollar(realNet),

      // Private — used by the outer function to aggregate.
      _displayAmountRaw: displayAmount,
      _phantomMarkupDelta: phantomMarkupDelta,
    };
  };

  // Stored subtotal — sum of extended_price for all lines. Real line
  // discounts are baked in; phantom line discounts are no-op at storage.
  const subtotalRaw = lines.reduce((sum, l) => sum + (Number(l.extended_price) || 0), 0);

  // Pre-format every line ONCE so we can reuse the per-line display
  // numbers for the footer aggregation below.
  const rawFormattedRegular = regularLines.map(fmtLine);
  const rawFormattedOptions = optionLines.map(fmtLine);
  const allFormattedLines = [...rawFormattedRegular, ...rawFormattedOptions];

  // Sum of displayed line amounts (marked up for phantom lines, stored
  // for real / none). This is what the "Subtotal" row on the PDF shows.
  const lineDisplaySubtotal = allFormattedLines.reduce(
    (sum, l) => sum + (l._displayAmountRaw || 0),
    0
  );
  // Aggregate phantom line markup — the amount that needs to appear in
  // the discount row so the net lands back at subtotalRaw.
  const linePhantomMarkupTotal = allFormattedLines.reduce(
    (sum, l) => sum + (l._phantomMarkupDelta || 0),
    0
  );

  // Header-level discount.
  //   - REAL: subtract from subtotalRaw before tax.
  //   - PHANTOM: mark up the displayed subtotal even further so the
  //     discount row returns to the real net.
  const headerDiscount = readDiscountFromRow(quote);
  const headerDiscountApplied = computeDiscountApplied(headerDiscount, subtotalRaw);
  const headerPhantom = headerDiscount && headerDiscount.isPhantom
    ? computePhantomMarkup(headerDiscount, lineDisplaySubtotal)
    : { grossDisplay: lineDisplaySubtotal, discountApplied: 0 };

  // The "Subtotal" row on the PDF = displayed line sum + header phantom markup.
  const subtotalDisplayed = headerPhantom.grossDisplay;

  // Aggregate discount displayed on the PDF — one number that covers
  // all the different kinds of discount the quote can have:
  //   - Line phantom markups (each phantom line contributes its markup)
  //   - Header real discount (dollar or pct of subtotal_raw)
  //   - Header phantom markup on top of the displayed line subtotal
  //
  // (Real line discounts do NOT appear here because the line's amount
  // column already shows the post-discount figure; subtotal ties out.)
  const aggregateDiscountDisplayed =
    linePhantomMarkupTotal +
    headerDiscountApplied +
    headerPhantom.discountApplied;

  const hasHeaderDiscount =
    aggregateDiscountDisplayed > 0 || !!headerDiscount?.description;
  const taxRaw = Number(quote.tax_amount) || 0;
  const totalAfterDiscount = subtotalRaw - headerDiscountApplied + taxRaw;

  // Sanity-check (dev only, cheap): (subtotalDisplayed - aggregateDiscount + tax)
  // must equal totalAfterDiscount. A mismatch means the math above drifted.
  // No exception on mismatch — we just log it server-side.
  if (Math.abs(
    (subtotalDisplayed - aggregateDiscountDisplayed + taxRaw) - totalAfterDiscount
  ) > 0.01) {
    console.warn('[doc-generate] discount math mismatch', {
      subtotalDisplayed,
      aggregateDiscountDisplayed,
      taxRaw,
      totalAfterDiscount,
      subtotalRaw,
      linePhantomMarkupTotal,
      headerDiscountApplied,
      headerPhantomDiscount: headerPhantom.discountApplied,
    });
  }

  // Build combined contact name
  const contactFirst = quote.contact_first || '';
  const contactLast  = quote.contact_last  || '';
  const contactFullName = [contactFirst, contactLast].filter(Boolean).join(' ');

  // Add WFM PascalCase aliases to each already-formatted line. Uses the
  // base object from fmtLine (which we pre-computed above) and attaches
  // the description from the raw line.
  //
  // Plus: a generous set of common-spelling aliases (Item / Title /
  // Qty / Price / LineAmount / etc.) so user-uploaded templates work
  // regardless of which naming convention they used for the loop body
  // placeholders.
  const addWfmAliases = (base, line) => ({
    ...base,
    // WFM-compatible aliases
    Name: base.title,
    Description: line.description || '',
    Note: base.note,
    Quantity: base.quantity,
    Rate: base.unitPrice,
    Amount: base.amount,
    Code: base.partNumber,

    // Common alt-spellings (camel + Pascal). Templates pick whichever
    // they use; missing keys silently render '' via nullGetter.
    Item:        base.title,
    item:        base.title,
    ItemName:    base.title,
    itemName:    base.title,
    Title:       base.title,
    description: line.description || '',
    note:        base.note,
    PartNumber:  base.partNumber,
    Part:        base.partNumber,
    code:        base.partNumber,
    Qty:         base.quantity,
    qty:         base.quantity,
    quantity:    base.quantity,    // explicit (already inherited from base)
    Unit:        base.unit,
    unit:        base.unit,
    Price:       base.unitPrice,
    UnitPrice:   base.unitPrice,
    LinePrice:   base.amount,
    LineAmount:  base.amount,
    Total:       base.amount,
    Extended:    base.amount,
    ExtendedPrice: base.amount,

    // Line discount (Phase 2) — templates that want to render a
    // "was X" or "discount -Y" alongside each line can use these.
    HasLineDiscount: base.hasLineDiscount,
    LineDiscountDescription: base.lineDiscountDescription,
    LineDiscountAmount: base.lineDiscountAmount,
    LineGrossAmount: base.lineGrossAmount,
    LineNetAmount: base.lineNetAmount,
  });

  const formattedLines = rawFormattedRegular.map((f, i) =>
    addWfmAliases(f, regularLines[i])
  );
  const formattedOptions = rawFormattedOptions.map((f, i) =>
    addWfmAliases(f, optionLines[i])
  );

  // ── T3.4 Sub-feature A — hybrid quote line sections ───────────────
  //
  // For single-type quotes, `sections` is a single-element array with
  // every line in it; the existing `lines`/`Task`/`Cost` arrays still
  // work for single-type templates. For hybrid quotes, lines are
  // grouped by `line_type` with per-section subtotals. Lines whose
  // `line_type` is NULL get bucketed into an "Unassigned" section so
  // they still appear in the PDF (flagged for the user to fix).
  //
  // Each section exposes:
  //   - key         ("spares" | "service" | ...)
  //   - label       ("Spares" | "Service" | "Unassigned")
  //   - lines       formatted lines (same shape as `lines`)
  //   - hasLines    boolean for template {#hasLines}...{/} loops
  //   - subtotal    formatted dollar string
  //   - subtotalRaw number, for math downstream
  const quoteTypeParts = parseQuoteTypes(quote.quote_type);
  const isHybrid = quoteTypeParts.length > 1;

  const sectionByKey = new Map();
  // Pre-seed sections in quoteTypeParts order so the PDF always
  // renders them in the canonical order (e.g. Spares before Service
  // when quote_type = "spares,service").
  for (const key of quoteTypeParts) {
    sectionByKey.set(key, {
      key,
      label: QUOTE_TYPE_LABELS[key] ?? key,
      lines: [],
      subtotalRaw: 0,
    });
  }
  // Fall back to a single "All lines" section for single-type quotes.
  if (quoteTypeParts.length === 1) {
    const only = sectionByKey.get(quoteTypeParts[0]);
    only.label = QUOTE_TYPE_LABELS[quoteTypeParts[0]] ?? only.label;
  } else if (quoteTypeParts.length === 0) {
    sectionByKey.set('_all', {
      key: '_all',
      label: 'All lines',
      lines: [],
      subtotalRaw: 0,
    });
  }

  formattedLines.forEach((fl, i) => {
    const raw = regularLines[i];
    let targetKey;
    if (isHybrid) {
      targetKey = raw.line_type && quoteTypeParts.includes(raw.line_type)
        ? raw.line_type
        : '_unassigned';
      if (!sectionByKey.has(targetKey)) {
        sectionByKey.set(targetKey, {
          key: targetKey,
          label: targetKey === '_unassigned'
            ? 'Unassigned'
            : (QUOTE_TYPE_LABELS[targetKey] ?? targetKey),
          lines: [],
          subtotalRaw: 0,
        });
      }
    } else {
      targetKey = quoteTypeParts[0] ?? '_all';
    }
    const section = sectionByKey.get(targetKey);
    section.lines.push(fl);
    section.subtotalRaw += Number(raw.extended_price) || 0;
  });

  const sections = Array.from(sectionByKey.values())
    .filter(s => s.lines.length > 0)
    .map(s => ({
      key: s.key,
      label: s.label,
      lines: s.lines,
      hasLines: s.lines.length > 0,
      subtotal: fmtDollar(s.subtotalRaw),
      subtotalRaw: s.subtotalRaw,
      // WFM-compatible PascalCase aliases for the template author's
      // convenience — templates can loop {#Sections}{Label}{Subtotal}
      // {#Lines}...{/Lines}{/Sections}.
      Key: s.key,
      Label: s.label,
      Lines: s.lines,
      HasLines: s.lines.length > 0,
      Subtotal: fmtDollar(s.subtotalRaw),
    }));

  // Quote number: omit "Rev" for v1
  const quoteNumDisplay = quote.revision && quote.revision !== 'v1'
    ? `${quote.number} Rev ${quote.revision}`
    : quote.number;

  return {
    // Header — camelCase (Pipeline)
    clientName: quote.account_name || '',
    clientAlias: quote.account_alias || '',
    clientAddress: billingAddr?.address || '',
    quoteNumber: quoteNumDisplay,
    quoteDate: fmtDate(quote.submitted_at) || fmtDate(new Date().toISOString()),
    quoteExpiration: fmtDate(quote.valid_until),
    delivery: quote.delivery_estimate || '',
    description: quote.description || '',

    // Contact info — camelCase (Pipeline)
    contactFirstName: contactFirst,
    contactLastName:  contactLast,
    contactEmail: quote.contact_email || '',
    contactPhone: quote.contact_phone || '',
    contactTitle: quote.contact_title || '',
    contactName:  contactFullName,

    // Line items — camelCase (Pipeline)
    lines: formattedLines,
    options: formattedOptions,
    hasOptions: optionLines.length > 0,
    optionHeading: 'Preferred Options',
    quoteOptionExplanation: '',

    // T3.4 Sub-feature A — hybrid quote sections. For single-type
    // quotes `sections` is a one-element array; for hybrid quotes it
    // contains one entry per line_type with per-section subtotals.
    // `isHybrid` is the quick branch for template authors:
    //   {#isHybrid}{#sections}...{/sections}{/isHybrid}
    //   {^isHybrid}{#lines}...{/lines}{/isHybrid}
    sections,
    isHybrid,
    quoteTypeLabel: quoteTypeParts.length > 0
      ? quoteTypeParts.map(p => QUOTE_TYPE_LABELS[p] ?? p).join(' + ')
      : '',

    // Pricing breakdown — camelCase (Pipeline)
    // `quoteSubtotal` is the DISPLAYED subtotal (with phantom markups in).
    // `quoteSubtotalStored` is the real banked subtotal. For quotes
    // without any phantom discounts the two are equal.
    quoteSubtotal: fmtDollar(subtotalDisplayed),
    quoteSubtotalStored: fmtDollar(subtotalRaw),
    quoteTax: fmtDollar(quote.tax_amount),
    quoteTotal: fmtDollar(quote.total_price),

    // Header-level discount (T3.2 Phase 1 + Phase 2 phantom rendering)
    // Templates can conditionally render a discount row with:
    //   {#hasDiscount} Discount: -{quoteDiscountAmount} {/hasDiscount}
    hasDiscount: hasHeaderDiscount,
    quoteDiscountDescription: headerDiscount?.description || 'Discount',
    quoteDiscountAmount: fmtDollar(aggregateDiscountDisplayed),
    quoteDiscountPct:
      headerDiscount?.pct != null ? `${Number(headerDiscount.pct).toFixed(1)}%` : '',
    // Pre-discount subtotal — the marked-up figure for phantom headers;
    // same as quoteSubtotal when there is no phantom markup.
    quoteSubtotalPreDiscount: fmtDollar(subtotalDisplayed),
    // Post-discount, pre-tax figure. Useful for templates that want to
    // show a "Net total" line above tax.
    quoteNetAfterDiscount: fmtDollar(subtotalRaw - headerDiscountApplied),
    // Grand total with discount applied (matches stored total_price for
    // real discounts — belt and suspenders in case the stored value is
    // momentarily stale).
    quoteTotalAfterDiscount: fmtDollar(totalAfterDiscount),

    // Quote extras
    quoteTitle: quote.title || '',
    incoterms: quote.incoterms || '',
    currency: quote.currency || 'USD',

    // Opportunity context
    opportunityNumber: quote.opp_number || '',
    opportunityTitle: quote.opp_title || '',
    customerPO: quote.customer_po_number || '',

    // Governance snapshots
    tcRevision: quote.tc_revision || '',
    warrantyRevision: quote.warranty_revision || '',
    rateScheduleRevision: quote.rate_schedule_revision || '',
    sopRevision: quote.sop_revision || '',

    // Notes and terms
    quoteNotes: quote.notes_customer || '',
    quoteTerms: quote.payment_terms || '',
    deliveryTerms: quote.delivery_terms || '',

    // OC-specific (populated when generating OC docs)
    ocDate: '',

    // ── WFM-compatible PascalCase aliases ──
    // Client & contact
    ClientName: quote.account_name || '',
    ClientBillingAddress: billingAddr?.address || '',
    ClientAddressText: billingAddr?.address || '',
    ContactName: contactFullName,
    ContactEmail: quote.contact_email || '',
    ContactMobile: quote.contact_phone || '',

    // Document headers
    QuoteNumber: quoteNumDisplay,
    QuoteName: quote.title || '',
    QuoteDescription: quote.description || '',
    QuoteValidDate: fmtDate(quote.valid_until),
    Date: fmtDate(quote.submitted_at) || fmtDate(new Date().toISOString()),
    Today: fmtDate(new Date().toISOString()),
    TITLE: quote.title || '',
    OrderNumber: quote.customer_po_number || '',

    // Financial totals (displayed — phantom markups included)
    QuoteSubTotal: fmtDollar(subtotalDisplayed),
    QuoteTaxTotal: fmtDollar(quote.tax_amount),
    QuoteTotal: fmtDollar(quote.total_price),

    // WFM-compatible discount aliases
    HasDiscount: hasHeaderDiscount,
    QuoteDiscountDescription: headerDiscount?.description || 'Discount',
    QuoteDiscountAmount: fmtDollar(aggregateDiscountDisplayed),
    QuoteSubTotalPreDiscount: fmtDollar(subtotalDisplayed),
    QuoteNetAfterDiscount: fmtDollar(subtotalRaw - headerDiscountApplied),

    // Job context
    JobName: quote.opp_title || '',
    JobNumber: quote.opp_number || '',
    JobDescription: quote.description || '',
    JobClientOrderNumber: quote.customer_po_number || '',

    // Notes / terms / governance
    PreferenceTerms: quote.payment_terms || '',

    // WFM table loops (alias for {#Task}...{/Task}, {#Cost}...{/Cost})
    Task: formattedLines,
    Cost: formattedLines,
    Option: formattedOptions,
    // Hybrid sections (WFM PascalCase): loop via {#Sections}...{/Sections}.
    Sections: sections,
    IsHybrid: isHybrid,
    QuoteTypeLabel: quoteTypeParts.length > 0
      ? quoteTypeParts.map(p => QUOTE_TYPE_LABELS[p] ?? p).join(' + ')
      : '',

    // Metadata for filename/storage
    _quoteId: quote.id,
    _opportunityId: quote.opportunity_id,
    _number: quote.number,
    _revision: quote.revision,
    _quoteType: quote.quote_type,

    // ── Specific aliases requested by templates in the wild ──
    // From /templates/quote-eps/inspect: the user's template uses these
    // exact PascalCase / camel-mix names. Provided as a separate group
    // from the more-defensive alias block below so future similar
    // requests are easy to spot and add.
    ClientPostalAddressText: billingAddr?.address || '',
    QuoteDate:               fmtDate(quote.submitted_at) || fmtDate(new Date().toISOString()),
    QuotedDelivery:          quote.delivery_estimate || '',
    QuoteNotesExternal:      quote.notes_customer || '',
    QuoteOptionExplanation:  '',
    PreferenceOptionHeading: 'Preferred Options',

    // ── Defensive placeholder aliases ──
    // Templates uploaded by users may use slightly different naming
    // conventions than ours. Rather than hunt down whichever variant
    // they used, we provide every common spelling for each field. The
    // total cost is small (a few extra string fields per render) and
    // it makes "I uploaded my template and it shows blanks" a non-bug.
    //
    // Fields covered: address, date, delivery, line items array,
    // payment terms, and a numeric-only total for templates that
    // hard-code the "$" prefix.
    Address:           billingAddr?.address || '',
    address:           billingAddr?.address || '',
    BillingAddress:    billingAddr?.address || '',
    billingAddress:    billingAddr?.address || '',
    ClientCity:        '',  // legacy; addresses are single-field now
    ClientCountry:     '',  // legacy

    date:              fmtDate(quote.submitted_at) || fmtDate(new Date().toISOString()),
    DocumentDate:      fmtDate(quote.submitted_at) || fmtDate(new Date().toISOString()),
    IssueDate:         fmtDate(quote.submitted_at) || fmtDate(new Date().toISOString()),

    Delivery:          quote.delivery_estimate || '',
    deliveryEstimate:  quote.delivery_estimate || '',
    DeliveryEstimate:  quote.delivery_estimate || '',
    delivery_estimate: quote.delivery_estimate || '',

    LineItems:         formattedLines,
    lineItems:         formattedLines,
    Items:             formattedLines,
    items:             formattedLines,

    Terms:             quote.payment_terms || '',
    terms:             quote.payment_terms || '',
    PaymentTerms:      quote.payment_terms || '',
    paymentTerms:      quote.payment_terms || '',
    QuoteTerms:        quote.payment_terms || '',
    payment_terms:     quote.payment_terms || '',
    EpsTerms:          quote.payment_terms || '',
    EPSTerms:          quote.payment_terms || '',
    PaymentSchedule:   quote.payment_terms || '',
    paymentSchedule:   quote.payment_terms || '',

    DeliveryTerms:     quote.delivery_terms || '',
    delivery_terms:    quote.delivery_terms || '',

    // Numeric-only totals for templates that hardcode the "$" prefix.
    // (Otherwise users get "$$1,234,567.00" because both the template
    // and fmtDollar add a "$".)
    QuoteTotalAmount:    fmtAmount(quote.total_price),
    quoteTotalAmount:    fmtAmount(quote.total_price),
    TotalAmount:         fmtAmount(quote.total_price),
    QuoteSubtotalAmount: fmtAmount(subtotalDisplayed),
    QuoteTaxAmount:      fmtAmount(quote.tax_amount),
  };
}

/** Number-only formatter — returns '1,234.56' (no '$' prefix). Used to
 * provide '*Amount' aliases that pair with templates whose .docx
 * markup hardcodes the dollar sign. */
function fmtAmount(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Load OC data ────────────────────────────────────────────────────

/**
 * Load all the data needed to populate an Order Confirmation template.
 * The OC is a confirmation of an accepted quote, so we reuse the
 * quote's getQuoteDocData output and layer OC-specific fields on top
 * (oc_number, customer_po_number, oc_date, job number).
 *
 * Picks the most recently updated 'accepted' quote on the job's
 * parent opportunity; falls back to the most recent issued/revision_
 * issued if nothing is formally accepted yet (defensive — issue-oc
 * normally runs after accept).
 */
export async function getOcDocData(env, jobId) {
  const job = await one(
    env.DB,
    `SELECT j.*, o.number AS opp_number, o.title AS opp_title,
            o.account_id, o.customer_po_number AS opp_customer_po,
            a.name AS account_name, a.alias AS account_alias
       FROM jobs j
       JOIN opportunities o ON o.id = j.opportunity_id
       JOIN accounts a ON a.id = o.account_id
      WHERE j.id = ?`,
    [jobId]
  );
  if (!job) return null;

  // Prefer the job's source quote (jobs.quote_id) — an opportunity
  // can have multiple accepted quotes feeding multiple jobs, so we
  // can't just pick "the most recent accepted on the opp" without
  // risk of pulling the wrong quote's data. Fall back to the most-
  // recent accepted/issued for legacy jobs created before quote_id
  // was wired on the INSERT.
  let quote = job.quote_id
    ? await one(env.DB, 'SELECT id FROM quotes WHERE id = ?', [job.quote_id])
    : null;
  if (!quote) {
    quote = await one(
      env.DB,
      `SELECT id FROM quotes
        WHERE opportunity_id = ? AND status = 'accepted'
        ORDER BY updated_at DESC LIMIT 1`,
      [job.opportunity_id]
    );
  }
  if (!quote) {
    quote = await one(
      env.DB,
      `SELECT id FROM quotes
        WHERE opportunity_id = ? AND status IN ('issued', 'revision_issued')
        ORDER BY updated_at DESC LIMIT 1`,
      [job.opportunity_id]
    );
  }
  if (!quote) return null;

  const quoteData = await getQuoteDocData(env, quote.id);
  if (!quoteData) return null;

  const ocDate = (job.oc_issued_at || '').slice(0, 10);
  const customerPo = job.customer_po_number || job.opp_customer_po || '';

  return {
    ...quoteData,
    // OC-specific fields (camelCase for new templates)
    ocNumber: job.oc_number || '',
    ocDate,
    customerPoNumber: customerPo,
    jobNumber: job.number,
    jobType: job.job_type,
    _jobId: job.id,
    // PascalCase aliases (matches WFM convention used in quote templates)
    OcNumber: job.oc_number || '',
    OcDate: ocDate,
    CustomerPoNumber: customerPo,
    JobNumber: job.number,
  };
}

// ── Placeholder PDF ────────────────────────────────────────────────

/**
 * Generate a minimal, self-contained PDF with a single line of large
 * centered text. Used as a fallback when the requested .docx template
 * hasn't been uploaded to R2 yet so the download flow keeps working
 * end-to-end. Pure JS — no template dependency, no external API.
 *
 * The output is intentionally tiny (~600 bytes): one page, one font,
 * no metadata. It's a placeholder, not a polished document.
 */
export function makePlaceholderPdf(label) {
  // PDF strings must escape \ ( ) — they're the string delimiters.
  const safe = String(label)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');

  const fontSize = 28;
  const pageW = 612;   // US Letter @ 72 dpi
  const pageH = 792;
  // Helvetica-Bold advance width ≈ 556/1000 em at this font size.
  const textWidth = safe.length * fontSize * 0.556;
  const x = Math.max(36, (pageW - textWidth) / 2);
  const y = pageH / 2 + fontSize / 3;

  const content = `BT /F1 ${fontSize} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${safe}) Tj ET`;

  // Accumulate the PDF body, tracking object byte offsets for the xref.
  const offsets = [];
  const parts = [];
  parts.push('%PDF-1.4\n');

  const add = (obj) => {
    // Byte offset of the start of this object = current length of the
    // joined output. We concatenate with single-byte characters only
    // so .length === byte count.
    offsets.push(parts.join('').length);
    parts.push(obj);
  };

  add('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  add('2 0 obj\n<< /Type /Pages /Count 1 /Kids [3 0 R] >>\nendobj\n');
  add(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`);
  add('4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n');
  add(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);

  const body = parts.join('');
  const xrefStart = body.length;
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  for (const off of offsets) {
    xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer << /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  const full = body + xref;
  const bytes = new Uint8Array(full.length);
  for (let i = 0; i < full.length; i++) bytes[i] = full.charCodeAt(i) & 0xff;
  return bytes.buffer;
}

/**
 * Produce a rendered PDF for (templateKey, data) with graceful fallback:
 *   - If the .docx template exists in R2, fill it and convert to PDF.
 *   - If it's missing, return a placeholder PDF with "<templateKey>
 *     Placeholder" centered on the page. The download flow never errors
 *     just because an admin hasn't uploaded the template yet.
 *
 * Returns { buffer, isPlaceholder }.
 */
export async function renderPdfOrPlaceholder(env, templateKey, data, label) {
  const obj = await env.DOCS.get(templateKey);
  if (!obj) {
    return {
      buffer: makePlaceholderPdf(`${label || templateKey} Placeholder`),
      isPlaceholder: true,
    };
  }
  const docxBuffer = await fillTemplate(env, templateKey, data);
  const pdfBuffer = await convertToPdf(env, docxBuffer);
  return { buffer: pdfBuffer, isPlaceholder: false };
}

// ── Fill template ───────────────────────────────────────────────────

/**
 * Fetch a .docx template from R2 and fill it with data using docxtemplater.
 * Returns the filled document as an ArrayBuffer.
 */
export async function fillTemplate(env, templateKey, data) {
  const obj = await env.DOCS.get(templateKey);
  if (!obj) {
    throw new Error(`Template not found in R2: ${templateKey}`);
  }

  const templateBuf = await obj.arrayBuffer();
  const zip = new PizZip(templateBuf);

  // ── WFM → docxtemplater loop-syntax bridge ──
  // Templates authored in Word's mail-merge UX use:
  //   {TableStart:Cost}...{TableEnd:Cost}
  // docxtemplater's native loop syntax is:
  //   {#Cost}...{/Cost}
  // Without rewriting, the {TableStart:X} placeholders are treated
  // as ordinary lookups, find no matching key, and render empty —
  // and the row never repeats, so a 6-line quote shows one blank
  // row in the PDF.
  //
  // Word often splits the placeholder across runs as a side effect
  // of editing (`<w:t>{TableStart:</w:t><w:t>Cost}</w:t>`), so the
  // regex captures everything between the opening {TableStart:/
  // {TableEnd: and the closing brace, then strips any embedded XML
  // before recombining. The substitution merges any split runs into
  // one, which is fine for these invisible loop markers.
  rewriteWfmLoopMarkers(zip);

  // The whole docxtemplater interaction — construction, render, output
  // generation — can throw "Multi error" with the inner detail attached
  // at version-dependent paths (sometimes properties.errors, sometimes
  // top-level, sometimes via .cause). v3.x throws compile-time errors
  // at the constructor, so wrapping ONLY .render() misses those. We
  // wrap the entire block, then do an aggressive hunt for inner errors
  // before falling back to a JSON dump.
  let doc;
  try {
    doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      // Don't throw on missing placeholders — render them as empty
      nullGetter: () => '',
    });
    doc.render(data);
    return doc.getZip().generate({
      type: 'arraybuffer',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
  } catch (err) {
    const inner = findDocxInnerErrors(err);
    if (Array.isArray(inner) && inner.length > 0) {
      const parts = inner.slice(0, 5).map(e => {
        const id   = e?.properties?.id || e?.id || e?.name || 'error';
        const exp  = e?.properties?.explanation
                  || e?.explanation
                  || e?.message
                  || (typeof e === 'string' ? e : '')
                  || JSON.stringify(e?.properties || e || {}).slice(0, 200);
        const xtag = e?.properties?.xtag || e?.xtag;
        const ctx  = xtag ? ` (tag: ${xtag})` : '';
        return `${id}${ctx}: ${exp}`;
      });
      const overflow = inner.length > parts.length
        ? ` (+${inner.length - parts.length} more)`
        : '';
      const wrapped = new Error(parts.join(' · ') + overflow);
      wrapped.docxErrors = inner;
      throw wrapped;
    }
    // Last-ditch: serialize whatever non-enumerable bag of fields the
    // Error has so the flash message surfaces something instead of just
    // the generic "Multi error" string. Also include the constructor /
    // prototype name so we can tell where in the pipeline the throw
    // came from.
    const ctorName = err?.constructor?.name || err?.name || 'Error';
    const dump = dumpErrorShape(err);
    const wrapped = new Error(
      `docx ${ctorName} — ${err?.message || 'render error'}` +
      (dump ? ` — ${dump}` : '')
    );
    wrapped.cause = err;
    throw wrapped;
  }
}

// Hunt the inner errors array on a docxtemplater exception across all
// the paths I've seen across versions. Returns null if nothing array-
// shaped is found.
function findDocxInnerErrors(err) {
  if (!err) return null;
  const candidates = [
    err.properties?.errors,
    err.errors,
    err.properties?.id === 'multi_error' ? err.properties?.errors : null,
    err.cause?.properties?.errors,
    err.cause?.errors,
    Array.isArray(err) ? err : null,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) return c;
  }
  return null;
}

// Last-resort serializer — pulls every own property off an Error object
// (Errors don't enumerate normally) and returns a short JSON-ish blob
// so the flash message isn't just "Multi error" with no detail. Cap to
// 500 chars; the flash text shouldn't dominate the page.
function dumpErrorShape(err) {
  if (!err || typeof err !== 'object') return '';
  try {
    const acc = {};
    for (const k of Object.getOwnPropertyNames(err)) {
      if (k === 'stack') continue;  // noisy, not actionable
      const v = err[k];
      if (v == null) continue;
      if (typeof v === 'function') continue;
      // Inline simple values; deep-stringify objects
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        acc[k] = v;
      } else {
        try {
          acc[k] = JSON.parse(JSON.stringify(v));
        } catch (_) {
          acc[k] = String(v);
        }
      }
    }
    if (Object.keys(acc).length === 0) return '';
    return JSON.stringify(acc).slice(0, 500);
  } catch (_) {
    return '';
  }
}

function rewriteWfmLoopMarkers(zip) {
  // Walk every XML part — document.xml is the main one but headers
  // and footers can also contain template tokens.
  const xmlNames = Object.keys(zip.files).filter(
    n => n.endsWith('.xml') && n.startsWith('word/')
  );
  for (const name of xmlNames) {
    const original = zip.files[name].asText();
    let xml = original;

    // STEP 1: bridge split placeholders. Word often fragments a
    // `{Foo}` placeholder across multiple `<w:t>` runs as a side
    // effect of editing — e.g.
    //   <w:t>{</w:t></w:r><w:r><w:t>TableStart:Cost</w:t></w:r><w:r><w:t>}</w:t>
    // Without rejoining, the regex below can't see the literal
    // `{TableStart:` substring and the loop markers stay as plain
    // text — docxtemplater never recognizes the loop and the data
    // row renders just once with all inner placeholders empty.
    //
    // We find every `{...}` span (no nested braces) and strip the
    // run-boundary XML inside. Result is a single text run
    // containing the joined placeholder, ready for the marker rewrite
    // below. Curly braces that happen to contain bold/italic toggles
    // (which would also be `</w:t>...<w:t>` sequences) lose that
    // formatting — fine for our case since these are invisible
    // template tokens.
    if (xml.indexOf('{') >= 0) {
      xml = xml.replace(/\{([^{}]+)\}/g, (match, body) => {
        const bridged = body.replace(/<\/w:t>[\s\S]*?<w:t[^>]*>/g, '');
        return '{' + bridged + '}';
      });
    }

    // STEP 2: rewrite WFM-style loop markers to docxtemplater
    // native loop syntax. Now that placeholders are joined, simple
    // literal matching works.
    if (xml.indexOf('{TableStart:') < 0 && xml.indexOf('{TableEnd:') < 0) {
      // No markers anywhere — even after bridging, nothing to rewrite.
      // Skip the write so we don't churn the zip needlessly.
      if (xml === original) continue;
      zip.file(name, xml);
      continue;
    }
    xml = xml.replace(
      /\{(TableStart|TableEnd):([\s\S]*?)\}/g,
      (_match, kind, body) => {
        const cleaned = body.replace(/<[^>]+>/g, '').trim();
        if (!cleaned) return _match;
        return kind === 'TableStart' ? `{#${cleaned}}` : `{/${cleaned}}`;
      }
    );

    if (xml !== original) {
      zip.file(name, xml);
    }
  }
}

// ── Convert to PDF ──────────────────────────────────────────────────

/**
 * Convert a .docx ArrayBuffer to PDF via ConvertAPI.
 * Returns the PDF as an ArrayBuffer.
 */
export async function convertToPdf(env, docxBuffer) {
  const secret = env.CONVERTAPI_SECRET;
  if (!secret) {
    throw new Error('CONVERTAPI_SECRET is not configured');
  }

  const resp = await fetch(
    `https://v2.convertapi.com/convert/docx/to/pdf?Secret=${secret}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="document.docx"',
      },
      body: docxBuffer,
    }
  );

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`ConvertAPI failed (${resp.status}): ${text}`);
  }

  return await resp.arrayBuffer();
}
