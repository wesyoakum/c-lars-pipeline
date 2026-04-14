// functions/lib/doc-generate.js
//
// Core document generation: loads quote data, fills a docxtemplater
// template from R2, and optionally converts .docx → PDF via ConvertAPI.

import { one, all } from './db.js';
import { fmtDollar } from './pricing.js';
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

  // Format dollar amounts for line items
  const fmtLine = (line) => ({
    title: line.title || line.description || '',
    note: line.notes || line.line_notes || '',
    partNumber: line.part_number || '',
    quantity: line.quantity != null ? String(line.quantity) : '',
    unit: line.unit || '',
    unitPrice: fmtDollar(line.unit_price),
    amount: fmtDollar(line.extended_price),
    lineItemType: line.item_type || '',
  });

  // Compute subtotal from lines (sum of extended_price)
  const subtotalRaw = lines.reduce((sum, l) => sum + (Number(l.extended_price) || 0), 0);

  // Build combined contact name
  const contactFirst = quote.contact_first || '';
  const contactLast  = quote.contact_last  || '';
  const contactFullName = [contactFirst, contactLast].filter(Boolean).join(' ');

  // Format line items with both PMS camelCase and WFM PascalCase keys
  const fmtLineWfm = (line) => {
    const base = fmtLine(line);
    return {
      ...base,
      // WFM-compatible aliases
      Name: base.title,
      Description: line.description || '',
      Note: base.note,
      Quantity: base.quantity,
      Rate: base.unitPrice,
      Amount: base.amount,
      Code: base.partNumber,
    };
  };

  const formattedLines = regularLines.map(fmtLineWfm);
  const formattedOptions = optionLines.map(fmtLineWfm);

  // Quote number: omit "Rev" for v1
  const quoteNumDisplay = quote.revision && quote.revision !== 'v1'
    ? `${quote.number} Rev ${quote.revision}`
    : quote.number;

  return {
    // Header — camelCase (PMS)
    clientName: quote.account_name || '',
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
    quoteSubtotal: fmtDollar(subtotalRaw),
    quoteTax: fmtDollar(quote.tax_amount),
    quoteTotal: fmtDollar(quote.total_price),

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

    // Financial totals
    QuoteSubTotal: fmtDollar(subtotalRaw),
    QuoteTaxTotal: fmtDollar(quote.tax_amount),
    QuoteTotal: fmtDollar(quote.total_price),

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
