// functions/lib/doc-generate.js
//
// Core document generation: loads quote data, fills a docxtemplater
// template from R2, and optionally converts .docx → PDF via ConvertAPI.

import { one, all } from './db.js';
import { fmtDollar } from './pricing.js';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';

// ── Template key mapping ────────────────────────────────────────────

const TEMPLATE_MAP = {
  service:             'templates/quote-service.docx',
  spares:              'templates/quote-spares.docx',
  eps:                 'templates/quote-eps.docx',
  refurb_baseline:     'templates/quote-refurb-baseline.docx',
  refurb_modified:     'templates/quote-refurb-baseline.docx',
  refurb_supplemental: 'templates/quote-refurb-baseline.docx',
};

const OC_TEMPLATE = 'templates/oc-eps.docx';

export function templateKeyForQuote(quoteType) {
  return TEMPLATE_MAP[quoteType] || TEMPLATE_MAP.spares;
}

export { OC_TEMPLATE };

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
  });

  return {
    // Header
    clientName: quote.account_name || '',
    clientAddress: billingAddr?.address || '',
    quoteNumber: `${quote.number} Rev ${quote.revision}`,
    quoteDate: fmtDate(quote.submitted_at) || fmtDate(new Date().toISOString()),
    quoteExpiration: fmtDate(quote.valid_until),
    delivery: quote.delivery_estimate || '',
    description: quote.description || '',

    // Line items
    lines: regularLines.map(fmtLine),
    options: optionLines.map(fmtLine),
    hasOptions: optionLines.length > 0,
    optionHeading: 'Preferred Options',
    quoteOptionExplanation: '',

    // Totals
    quoteTotal: fmtDollar(quote.total_price),

    // Notes and terms
    quoteNotes: quote.notes_customer || '',
    quoteTerms: quote.payment_terms || '',
    deliveryTerms: quote.delivery_terms || '',

    // OC-specific (populated when generating OC docs)
    customerPO: '',
    ocDate: '',

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
      headers: { 'Content-Type': 'application/octet-stream' },
      body: docxBuffer,
    }
  );

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`ConvertAPI failed (${resp.status}): ${text}`);
  }

  const result = await resp.json();
  // ConvertAPI returns { Files: [{ FileData: base64string }] }
  const fileData = result?.Files?.[0]?.FileData;
  if (!fileData) {
    throw new Error('ConvertAPI returned no file data');
  }

  // Decode base64 to ArrayBuffer
  const binary = atob(fileData);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
