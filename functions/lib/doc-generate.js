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
import { TEMPLATE_CATALOG, templateTypeForQuote } from './template-catalog.js';

// ── Template key mapping ────────────────────────────────────────────

export function templateKeyForQuote(quoteType) {
  const catKey = templateTypeForQuote(quoteType);
  return TEMPLATE_CATALOG[catKey]?.r2Key || 'templates/quote-spares.docx';
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

  const billingAddr = addresses.find(a => a.id === quote.billing_address_id)
    || addresses.find(a => a.kind === 'billing' && a.is_default)
    || addresses.find(a => a.kind === 'billing')
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

  // Quote number: omit "Rev" for v1
  const quoteNumDisplay = quote.revision && quote.revision !== 'v1'
    ? `${quote.number} Rev ${quote.revision}`
    : quote.number;

  return {
    // Header — camelCase (PMS)
    clientName: quote.account_name || '',
    clientAlias: quote.account_alias || '',
    clientAddress: billingAddr?.address || '',
    quoteNumber: quoteNumDisplay,
    quoteDate: fmtDate(quote.submitted_at) || fmtDate(new Date().toISOString()),
    quoteExpiration: fmtDate(quote.valid_until),
    delivery: quote.delivery_estimate || '',
    description: quote.description || '',

    // Contact info — camelCase (PMS)
    contactFirstName: contactFirst,
    contactLastName:  contactLast,
    contactEmail: quote.contact_email || '',
    contactPhone: quote.contact_phone || '',
    contactTitle: quote.contact_title || '',
    contactName:  contactFullName,

    // Line items — camelCase (PMS)
    lines: formattedLines,
    options: formattedOptions,
    hasOptions: optionLines.length > 0,
    optionHeading: 'Preferred Options',
    quoteOptionExplanation: '',

    // Pricing breakdown — camelCase (PMS)
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

    // Metadata for filename/storage
    _quoteId: quote.id,
    _opportunityId: quote.opportunity_id,
    _number: quote.number,
    _revision: quote.revision,
    _quoteType: quote.quote_type,
  };
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

  const doc = new Docxtemplater(zip, {
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
