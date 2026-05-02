// functions/lib/claudia-documents-render.js
//
// Renders the two sidebars on /sandbox/assistant:
//   * left  — claudia-audio-panel  (audio recordings + transcripts)
//   * right — claudia-docs-panel   (everything else: PDF / DOCX / XLSX /
//                                    images / text)
//
// On any upload or retention change, BOTH panels need to refresh so a
// file can move between them (e.g. nothing's audio today, then you
// drop a wav). We do that with HTMX out-of-band swaps:
// renderBothPanels emits two top-level <div>s with
// hx-swap-oob="outerHTML". The HTMX action attribute on per-row
// buttons uses hx-swap="none" so HTMX picks up the OOB swaps without
// also swapping the target; the JS upload path parses the response
// and applies both replacements by id.
//
// renderDocumentsPanel is kept as an alias of renderBothPanels for
// existing call sites in the upload + retention endpoints.

const AUDIO_EXTS = new Set([
  'mp3', 'wav', 'm4a', 'mp4', 'ogg', 'oga', 'flac', 'webm', 'aac', 'wma',
]);

export function partitionDocs(docs) {
  const audio = [];
  const other = [];
  for (const d of docs) {
    if (isAudio(d)) audio.push(d);
    else other.push(d);
  }
  return { audio, other };
}

function isAudio(d) {
  const ct = String(d.content_type || '').toLowerCase();
  if (ct.startsWith('audio/')) return true;
  const ext = String(d.filename || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return ext ? AUDIO_EXTS.has(ext) : false;
}

export function renderBothPanels(allDocs, opts = {}) {
  const { audio, other } = partitionDocs(allDocs);
  // Both panels are top-level OOB-swap targets. Caller emits both into
  // the response body; HTMX (or the client-side JS upload path) picks
  // up each by id and replaces independently.
  return renderAudioPanel(audio, { ...opts, oob: true })
       + renderDocsPanel(other, { ...opts, oob: true });
}

// Back-compat alias used by the upload + retention endpoints.
export const renderDocumentsPanel = renderBothPanels;

// ---------- Right sidebar: non-audio documents ----------

export function renderDocsPanel(docs, opts = {}) {
  const oob = opts.oob ? ' hx-swap-oob="outerHTML"' : '';
  const errors = Array.isArray(opts.errors) ? opts.errors : [];
  const errorList = errors.length > 0
    ? `<div class="claudia-doc-flash error">
         <strong>Some files didn't go in:</strong>
         <ul>${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>
       </div>`
    : '';
  if (docs.length === 0 && errors.length === 0) {
    return `<div id="claudia-docs-panel" class="claudia-docs-panel claudia-docs-panel-empty"${oob}></div>`;
  }
  return `<div id="claudia-docs-panel" class="claudia-docs-panel"${oob}>
    ${errorList}
    <div class="claudia-docs-list">${docs.map(renderDocRow).join('')}</div>
  </div>`;
}

function renderDocRow(d) {
  const id = escapeAttr(d.id);
  const filename = escapeHtml(d.filename || 'untitled');
  const meta = [
    formatBytes(d.size_bytes),
    contentTypeShort(d.content_type, d.filename),
    formatRelative(d.created_at),
  ].filter(Boolean).join(' · ');
  const retention = d.retention || 'auto';
  const retentionBadge = retention === 'keep_forever'
    ? '<span class="claudia-doc-badge keep">★ kept</span>' : '';
  const statusBadge = d.extraction_status === 'error'
    ? `<span class="claudia-doc-badge error" title="${escapeAttr(d.extraction_error || '')}">extract failed</span>`
    : d.extraction_status === 'partial'
    ? '<span class="claudia-doc-badge warn">partial extract</span>' : '';
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
              hx-swap="none">★</button>
      <button type="button"
              class="claudia-doc-btn danger"
              title="Move to trash"
              hx-post="/sandbox/assistant/documents/${id}/retention?to=trashed"
              hx-swap="none"
              hx-confirm="Move this document to trash? You can restore it later from the database.">×</button>
    </div>
  </div>`;
}

// ---------- Left sidebar: audio recordings + transcripts ----------

export function renderAudioPanel(docs, opts = {}) {
  const oob = opts.oob ? ' hx-swap-oob="outerHTML"' : '';
  if (docs.length === 0) {
    return `<div id="claudia-audio-panel" class="claudia-audio-panel claudia-audio-panel-empty"${oob}></div>`;
  }
  return `<div id="claudia-audio-panel" class="claudia-audio-panel"${oob}>
    <div class="claudia-audio-list">${docs.map(renderAudioRow).join('')}</div>
  </div>`;
}

function renderAudioRow(d) {
  const id = escapeAttr(d.id);
  const filename = escapeHtml(d.filename || 'recording');
  const when = formatRelative(d.created_at);
  const meta = [formatBytes(d.size_bytes), when].filter(Boolean).join(' · ');
  const retention = d.retention || 'auto';
  const retentionBadge = retention === 'keep_forever'
    ? '<span class="claudia-doc-badge keep">★ kept</span>' : '';
  const statusBadge = d.extraction_status === 'error'
    ? `<span class="claudia-doc-badge error" title="${escapeAttr(d.extraction_error || '')}">transcription failed</span>`
    : d.extraction_status === 'partial'
    ? '<span class="claudia-doc-badge warn">partial</span>' : '';
  const isKept = retention === 'keep_forever';
  const keepHref = isKept ? 'auto' : 'keep_forever';
  const keepLabel = isKept ? 'Unkeep' : 'Keep forever';
  const keepClass = isKept ? 'active' : '';
  const transcriptText = String(d.preview || '').trim();
  const transcriptHtml = transcriptText
    ? `<div class="claudia-audio-transcript">${escapeHtml(transcriptText)}</div>`
    : '<div class="claudia-audio-transcript empty">(no transcript)</div>';

  return `<div class="claudia-audio-item" id="claudia-audio-${id}">
    <div class="claudia-audio-head">
      <span class="claudia-audio-filename" title="${escapeAttr(filename)}">${filename}</span>
      <div class="claudia-doc-actions">
        <button type="button"
                class="claudia-doc-btn ${keepClass}"
                title="${escapeAttr(keepLabel)}"
                hx-post="/sandbox/assistant/documents/${id}/retention?to=${keepHref}"
                hx-swap="none">★</button>
        <button type="button"
                class="claudia-doc-btn danger"
                title="Move to trash"
                hx-post="/sandbox/assistant/documents/${id}/retention?to=trashed"
                hx-swap="none"
                hx-confirm="Move this recording to trash? You can restore it later from the database.">×</button>
      </div>
    </div>
    ${transcriptHtml}
    <div class="claudia-audio-meta">${escapeHtml(meta)}${retentionBadge ? ' ' + retentionBadge : ''}${statusBadge ? ' ' + statusBadge : ''}</div>
  </div>`;
}

// ---------- Helpers ----------

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
