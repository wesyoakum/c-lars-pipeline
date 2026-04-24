// functions/lib/template-catalog.js
//
// Central catalog of all document templates stored in R2.
// Used by template download/upload routes and generation logic.

export const TEMPLATE_CATALOG = {
  'quote-service': {
    r2Key: 'templates/quote-service.docx',
    filename: 'quote-service.docx',
    label: 'Quote — Service',
  },
  'quote-spares': {
    r2Key: 'templates/quote-spares.docx',
    filename: 'quote-spares.docx',
    label: 'Quote — Spares',
  },
  'quote-eps': {
    r2Key: 'templates/quote-eps.docx',
    filename: 'quote-eps.docx',
    label: 'Quote — EPS',
  },
  'quote-refurb-baseline': {
    r2Key: 'templates/quote-refurb-baseline.docx',
    filename: 'quote-refurb-baseline.docx',
    label: 'Quote — Refurb Baseline',
  },
  'quote-refurb-modified': {
    r2Key: 'templates/quote-refurb-modified.docx',
    filename: 'quote-refurb-modified.docx',
    label: 'Quote — Refurb Modified',
  },
  'quote-change-order': {
    r2Key: 'templates/quote-change-order.docx',
    filename: 'quote-change-order.docx',
    label: 'Quote — Change Order',
  },
  'quote-hybrid': {
    r2Key: 'templates/quote-hybrid.docx',
    filename: 'quote-hybrid.docx',
    label: 'Quote — Hybrid (multi-type)',
    // T3.4 Sub-feature A — the real hybrid template isn't designed yet.
    // Until Wes uploads a quote-hybrid.docx via /templates/quote-hybrid,
    // doc-generate.js falls back to the primary type's template so
    // hybrid quotes still render (with a single flat line-item section).
    inProgress: true,
  },
  'oc-eps': {
    r2Key: 'templates/oc-eps.docx',
    filename: 'oc-eps.docx',
    label: 'Order Confirmation — EPS',
  },
  'oc-spares': {
    r2Key: 'templates/oc-spares.docx',
    filename: 'oc-spares.docx',
    label: 'Order Confirmation — Spares',
  },
  'oc-service': {
    r2Key: 'templates/oc-service.docx',
    filename: 'oc-service.docx',
    label: 'Order Confirmation — Service',
  },
  'oc-refurb': {
    r2Key: 'templates/oc-refurb.docx',
    filename: 'oc-refurb.docx',
    label: 'Order Confirmation — Refurb',
  },
  // Amended OC — issued after a change order is accepted. Universal
  // (any transaction type). Same data shape as OC plus amended_oc_*
  // fields from the change_orders row.
  'oc-amended': {
    r2Key: 'templates/oc-amended.docx',
    filename: 'oc-amended.docx',
    label: 'Order Confirmation — Amended',
  },
  'ntp': {
    r2Key: 'templates/ntp.docx',
    filename: 'ntp.docx',
    label: 'Notice to Proceed (NTP)',
  },
};

// Map quote_type values → template catalog key
const QUOTE_TYPE_TO_TEMPLATE = {
  service:         'quote-service',
  spares:          'quote-spares',
  eps:             'quote-eps',
  refurb_baseline: 'quote-refurb-baseline',
  refurb_modified: 'quote-refurb-modified',
};

// Map job type → OC template catalog key
const JOB_TYPE_TO_OC_TEMPLATE = {
  eps:    'oc-eps',
  spares: 'oc-spares',
  service: 'oc-service',
  refurb: 'oc-refurb',
};

/**
 * Resolve a quote_type value (which may be a single type like "spares"
 * or a comma-separated hybrid like "spares,service") to a template
 * catalog key.
 *
 * T3.4 Sub-feature A — hybrid quotes route to the shared `quote-hybrid`
 * template key. Until the hybrid .docx template is uploaded, the
 * document generator falls back to the primary type's template.
 */
export function templateTypeForQuote(quoteType, { isChangeOrder = false } = {}) {
  if (isChangeOrder) return 'quote-change-order';
  if (quoteType && String(quoteType).includes(',')) {
    return 'quote-hybrid';
  }
  return QUOTE_TYPE_TO_TEMPLATE[quoteType] || 'quote-spares';
}

/**
 * Primary-type fallback template key for a quote_type. Used by
 * doc-generate.js when a hybrid quote is being rendered but no
 * `quote-hybrid.docx` has been uploaded yet — we fall back to the
 * first part's single-type template so quotes still generate.
 */
export function fallbackTemplateTypeForQuote(quoteType) {
  if (!quoteType) return 'quote-spares';
  const firstPart = String(quoteType).split(',')[0].trim();
  return QUOTE_TYPE_TO_TEMPLATE[firstPart] || 'quote-spares';
}

export function templateTypeForOC(jobType) {
  return JOB_TYPE_TO_OC_TEMPLATE[jobType] || 'oc-spares';
}

/**
 * Render the template download/upload UI snippet.
 * Returns raw HTML string for embedding in a page.
 */
export function templateManagerHtml(templateType, { html, escape } = {}) {
  const entry = TEMPLATE_CATALOG[templateType];
  if (!entry) return '';

  return `
    <details class="template-manager" style="margin:0.5rem 0;font-size:0.85em">
      <summary style="cursor:pointer;color:var(--muted)">
        Template: ${entry.label}
      </summary>
      <div style="margin:0.35rem 0 0 1rem;display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap">
        <a href="/templates/${templateType}/download" class="btn btn-sm">Download Template</a>
        <form method="post" action="/templates/${templateType}/upload"
              enctype="multipart/form-data" class="inline-form"
              style="display:flex;align-items:center;gap:0.35rem">
          <input type="file" name="file" accept=".docx" style="font-size:0.85em;max-width:220px">
          <button type="submit" class="btn btn-sm">Upload</button>
        </form>
      </div>
    </details>`;
}
