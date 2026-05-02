// functions/lib/claudia-documents-render.js
//
// Shared HTML rendering for Claudia's documents panel — used by:
//   * functions/sandbox/assistant/index.js (initial server render)
//   * functions/sandbox/assistant/documents/index.js (upload swap target)
//   * functions/sandbox/assistant/documents/[id]/retention.js (after a
//     keep/trash flip; returns the refreshed panel for HTMX swap)
//
// All HTML output is escaped at the leaves; opts.errors strings ARE
// trusted to be plain text (caller should already have stripped any
// markup before passing them in — current callers pass raw error
// messages from extractText / fetch failures, which are fine).

export function renderDocumentsPanel(docs, opts = {}) {
  const errors = Array.isArray(opts.errors) ? opts.errors : [];
  const rows = docs.map(renderDocRow).join('');
  const errorList = errors.length > 0
    ? `<div class="claudia-doc-flash error">
         <strong>Some files didn't go in:</strong>
         <ul>${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>
       </div>`
    : '';
  if (docs.length === 0 && errors.length === 0) {
    // Empty placeholder so HTMX swap targets stay visible.
    return `<div id="claudia-docs-panel" class="claudia-docs-panel claudia-docs-panel-empty"></div>`;
  }
  return `<div id="claudia-docs-panel" class="claudia-docs-panel">
    ${errorList}
    <div class="claudia-docs-list">${rows}</div>
  </div>`;
}

function renderDocRow(d) {
  const id = escapeAttr(d.id);
  const filename = escapeHtml(d.filename || 'untitled');
  const meta = [
    formatBytes(d.size_bytes),
    contentTypeShort(d.content_type, d.filename),
    formatRelative(d.created_at),
  ]
    .filter(Boolean)
    .join(' · ');
  const retention = d.retention || 'auto';
  const retentionBadge = retention === 'keep_forever'
    ? '<span class="claudia-doc-badge keep">★ kept</span>'
    : '';
  const statusBadge = d.extraction_status === 'error'
    ? `<span class="claudia-doc-badge error" title="${escapeAttr(d.extraction_error || '')}">extract failed</span>`
    : d.extraction_status === 'partial'
    ? '<span class="claudia-doc-badge warn">partial extract</span>'
    : '';

  // Two-button toggle: keep / trash. Active state shown by retention.
  const isKept = retention === 'keep_forever';
  const keepHref = isKept ? 'auto' : 'keep_forever';
  const keepLabel = isKept ? 'Unkeep' : 'Keep forever';
  const keepClass = isKept ? 'active' : '';

  return `<div class="claudia-doc" id="claudia-doc-${id}">
    <div class="claudia-doc-main">
      <div class="claudia-doc-title">
        <span class="claudia-doc-filename">${filename}</span>
        ${retentionBadge}${statusBadge}
      </div>
      <div class="claudia-doc-meta">${escapeHtml(meta)}</div>
    </div>
    <div class="claudia-doc-actions">
      <button type="button"
              class="claudia-doc-btn ${keepClass}"
              title="${escapeAttr(keepLabel)}"
              hx-post="/sandbox/assistant/documents/${id}/retention?to=${keepHref}"
              hx-target="#claudia-docs-panel"
              hx-swap="outerHTML">★</button>
      <button type="button"
              class="claudia-doc-btn danger"
              title="Move to trash"
              hx-post="/sandbox/assistant/documents/${id}/retention?to=trashed"
              hx-target="#claudia-docs-panel"
              hx-swap="outerHTML"
              hx-confirm="Move this document to trash? You can restore it later from the database.">×</button>
    </div>
  </div>`;
}

function contentTypeShort(ct, filename) {
  const ext = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext) return ext.toUpperCase();
  if (!ct) return '';
  if (ct === 'application/pdf') return 'PDF';
  if (ct.startsWith('text/')) return ct.slice(5).toUpperCase();
  return ct.split('/').pop().toUpperCase();
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatRelative(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const diffMin = Math.round((Date.now() - ms) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(ms).toLocaleDateString();
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return escapeHtml(s);
}
