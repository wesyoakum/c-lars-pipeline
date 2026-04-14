// functions/documents/library.js
//
// GET /documents/library — Document library listing all uploaded documents
// with filters for kind, file type, date, and linked entity.

import { all } from '../lib/db.js';
import { layout, htmlResponse, html, raw, escape } from '../lib/layout.js';
import { readFlash } from '../lib/http.js';

const DOC_KIND_LABELS = {
  rfq: 'RFQ',
  rfi: 'RFI',
  quote_pdf: 'Quote PDF',
  quote_docx: 'Quote DOCX',
  po: 'PO',
  oc_pdf: 'OC PDF',
  ntp_pdf: 'NTP PDF',
  drawing: 'Drawing',
  specification: 'Specification',
  supplier_quote: 'Supplier Quote',
  image: 'Image / Photo',
  other: 'Other',
};

function formatSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileTypeFromMime(mime) {
  if (!mime) return 'other';
  if (mime.includes('pdf')) return 'PDF';
  if (mime.includes('word') || mime.includes('docx')) return 'Word';
  if (mime.includes('spreadsheet') || mime.includes('xlsx') || mime.includes('excel')) return 'Excel';
  if (mime.includes('image/')) return 'Image';
  if (mime.includes('text/')) return 'Text';
  return 'Other';
}

function fileIcon(mime) {
  if (!mime) return '📎';
  if (mime.includes('pdf')) return '📄';
  if (mime.includes('word') || mime.includes('docx')) return '📝';
  if (mime.includes('image/')) return '🖼️';
  if (mime.includes('spreadsheet') || mime.includes('xlsx') || mime.includes('excel')) return '📊';
  return '📎';
}

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);

  const docs = await all(
    env.DB,
    `SELECT d.id, d.kind, d.title, d.original_filename, d.mime_type,
            d.size_bytes, d.notes, d.uploaded_at,
            d.opportunity_id, d.quote_id, d.job_id, d.account_id, d.cost_build_id,
            u.display_name AS uploaded_by_name, u.email AS uploaded_by_email,
            o.number AS opp_number, o.title AS opp_title,
            q.number AS quote_number, q.revision AS quote_revision,
            j.number AS job_number,
            a.name AS account_name
       FROM documents d
       LEFT JOIN users u        ON u.id = d.uploaded_by_user_id
       LEFT JOIN opportunities o ON o.id = d.opportunity_id
       LEFT JOIN quotes q       ON q.id = d.quote_id
       LEFT JOIN jobs j         ON j.id = d.job_id
       LEFT JOIN accounts a     ON a.id = d.account_id
      ORDER BY d.uploaded_at DESC
      LIMIT 1000`
  );

  // Build filter option sets from data
  const kinds = new Set();
  const fileTypes = new Set();
  const accounts = new Map();
  docs.forEach(d => {
    kinds.add(d.kind);
    fileTypes.add(fileTypeFromMime(d.mime_type));
    if (d.account_name) accounts.set(d.account_id, d.account_name);
  });

  const rowData = docs.map(d => {
    const ft = fileTypeFromMime(d.mime_type);
    // Determine attached-to entity
    let attachedTo = '';
    let attachedUrl = '';
    if (d.quote_id && d.quote_number) {
      attachedTo = `${d.quote_number} Rev ${d.quote_revision || ''}`;
      attachedUrl = `/opportunities/${d.opportunity_id}/quotes/${d.quote_id}`;
    } else if (d.job_id && d.job_number) {
      attachedTo = d.job_number;
      attachedUrl = `/jobs/${d.job_id}`;
    } else if (d.opportunity_id && d.opp_number) {
      attachedTo = `${d.opp_number}${d.opp_title ? ' — ' + d.opp_title : ''}`;
      attachedUrl = `/opportunities/${d.opportunity_id}`;
    } else if (d.account_id && d.account_name) {
      attachedTo = d.account_name;
      attachedUrl = `/accounts/${d.account_id}`;
    }
    return { ...d, fileType: ft, attachedTo, attachedUrl };
  });

  const body = html`
    <section class="card">
      <div class="card-header">
        <h1 class="page-title">Documents</h1>
        <div class="toolbar-right" style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap">
          <select id="dl-kind-filter" data-role="filter" data-col="kind" style="font-size:0.85em">
            <option value="">All Types</option>
            ${[...kinds].sort().map(k => html`<option value="${escape(k)}">${escape(DOC_KIND_LABELS[k] || k)}</option>`)}
          </select>
          <select id="dl-file-filter" data-role="filter" data-col="fileType" style="font-size:0.85em">
            <option value="">All Formats</option>
            ${[...fileTypes].sort().map(ft => html`<option value="${escape(ft)}">${escape(ft)}</option>`)}
          </select>
          <select id="dl-acct-filter" data-role="filter" data-col="account" style="font-size:0.85em">
            <option value="">All Accounts</option>
            ${[...accounts.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) =>
              html`<option value="${escape(name)}">${escape(name)}</option>`
            )}
          </select>
          <div class="search-expand">
            <label class="search-icon" for="dl-search">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8.5" cy="8.5" r="5.5"/><line x1="13" y1="13" x2="18" y2="18"/></svg>
            </label>
            <input type="search" id="dl-search" data-role="quicksearch" placeholder="Search...">
          </div>
          <span class="muted" data-role="count" style="font-size:0.8em;white-space:nowrap">${docs.length}</span>
        </div>
      </div>

      ${docs.length === 0
        ? html`<p class="muted" style="padding:1rem">No documents uploaded yet.</p>`
        : html`
          <table class="data" id="doc-lib-table">
            <thead>
              <tr>
                <th></th>
                <th data-sort="title">Name</th>
                <th data-sort="kind">Type</th>
                <th data-sort="fileType">Format</th>
                <th data-sort="attachedTo">Attached To</th>
                <th data-sort="account">Account</th>
                <th data-sort="size" class="num">Size</th>
                <th data-sort="date">Uploaded</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              ${rowData.map(d => html`
                <tr data-searchable="${escape((d.title || '') + ' ' + (d.original_filename || '') + ' ' + (d.attachedTo || '') + ' ' + (d.account_name || ''))}"
                    data-kind="${escape(d.kind)}"
                    data-filetype="${escape(d.fileType)}"
                    data-account="${escape(d.account_name || '')}"
                    data-date="${escape((d.uploaded_at || '').slice(0, 10))}"
                    data-size="${d.size_bytes || 0}">
                  <td>${fileIcon(d.mime_type)}</td>
                  <td>
                    <a href="/documents/${escape(d.id)}/download">${escape(d.title || d.original_filename || 'Untitled')}</a>
                    ${d.original_filename && d.original_filename !== d.title
                      ? html`<br><small class="muted">${escape(d.original_filename)}</small>`
                      : ''}
                    ${d.notes ? html`<br><small class="muted">${escape(d.notes)}</small>` : ''}
                  </td>
                  <td><span class="pill" style="font-size:0.8em">${escape(DOC_KIND_LABELS[d.kind] || d.kind)}</span></td>
                  <td class="muted" style="font-size:0.85em">${escape(d.fileType)}</td>
                  <td>
                    ${d.attachedUrl
                      ? html`<a href="${escape(d.attachedUrl)}">${escape(d.attachedTo)}</a>`
                      : html`<span class="muted">—</span>`}
                  </td>
                  <td>${d.account_name ? html`<a href="/accounts/${escape(d.account_id)}">${escape(d.account_name)}</a>` : html`<span class="muted">—</span>`}</td>
                  <td class="num muted" style="font-size:0.85em;white-space:nowrap">${formatSize(d.size_bytes)}</td>
                  <td class="muted" style="font-size:0.85em;white-space:nowrap">${(d.uploaded_at || '').slice(0, 10)}</td>
                  <td class="muted" style="font-size:0.85em">${escape(d.uploaded_by_name || d.uploaded_by_email || '—')}</td>
                </tr>
              `)}
            </tbody>
          </table>`}
    </section>

    <script>
    (function() {
      var table = document.getElementById('doc-lib-table');
      if (!table) return;
      var tbody = table.querySelector('tbody');
      var rows = Array.from(tbody.querySelectorAll('tr'));
      var countEl = document.querySelector('[data-role="count"]');

      function applyFilters() {
        var search = (document.getElementById('dl-search')?.value || '').toLowerCase();
        var kindFilter = document.getElementById('dl-kind-filter')?.value || '';
        var fileFilter = document.getElementById('dl-file-filter')?.value || '';
        var acctFilter = document.getElementById('dl-acct-filter')?.value || '';
        var visible = 0;
        rows.forEach(function(row) {
          var show = true;
          if (search && !(row.dataset.searchable || '').toLowerCase().includes(search)) show = false;
          if (kindFilter && row.dataset.kind !== kindFilter) show = false;
          if (fileFilter && row.dataset.filetype !== fileFilter) show = false;
          if (acctFilter && row.dataset.account !== acctFilter) show = false;
          row.style.display = show ? '' : 'none';
          if (show) visible++;
        });
        if (countEl) countEl.textContent = visible + ' / ' + rows.length;
      }

      document.getElementById('dl-search')?.addEventListener('input', applyFilters);
      document.getElementById('dl-kind-filter')?.addEventListener('change', applyFilters);
      document.getElementById('dl-file-filter')?.addEventListener('change', applyFilters);
      document.getElementById('dl-acct-filter')?.addEventListener('change', applyFilters);

      // Column sorting
      table.querySelectorAll('th[data-sort]').forEach(function(th) {
        th.style.cursor = 'pointer';
        th.addEventListener('click', function() {
          var key = th.dataset.sort;
          var asc = th.dataset.dir !== 'asc';
          table.querySelectorAll('th[data-sort]').forEach(function(h) { h.dataset.dir = ''; });
          th.dataset.dir = asc ? 'asc' : 'desc';
          rows.sort(function(a, b) {
            var va, vb;
            if (key === 'size') {
              va = parseInt(a.dataset.size) || 0;
              vb = parseInt(b.dataset.size) || 0;
            } else if (key === 'date') {
              va = a.dataset.date || '';
              vb = b.dataset.date || '';
            } else {
              var col = Array.from(th.parentNode.children).indexOf(th);
              va = (a.children[col]?.textContent || '').toLowerCase();
              vb = (b.children[col]?.textContent || '').toLowerCase();
            }
            if (va < vb) return asc ? -1 : 1;
            if (va > vb) return asc ? 1 : -1;
            return 0;
          });
          rows.forEach(function(r) { tbody.appendChild(r); });
        });
      });

      if (countEl) countEl.textContent = rows.length;
    })();
    </script>
  `;

  return htmlResponse(
    layout('Documents', body, {
      user,
      env: data?.env,
      activeNav: '/documents',
      flash: readFlash(url),
      breadcrumbs: [{ label: 'Documents' }],
    })
  );
}
