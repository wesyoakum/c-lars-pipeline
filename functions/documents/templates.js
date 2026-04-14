// functions/documents/templates.js
//
// GET /documents/templates — Template manager page.
// Lists every template from the catalog, shows which ones exist in R2
// (with size / last-modified), and provides download + upload/replace
// all inline in a single row per template.

import { layout, htmlResponse, html, raw, escape } from '../lib/layout.js';
import { readFlash } from '../lib/http.js';
import { TEMPLATE_CATALOG } from '../lib/template-catalog.js';
import { listScript, listTableHead, listToolbar, rowDataAttrs } from '../lib/list-table.js';
import { docsSubNav } from '../lib/docs-subnav.js';

function formatSize(bytes) {
  if (!bytes) return '\u2014';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Derive category from the template key. */
function templateCategory(key) {
  if (key.startsWith('quote-')) return 'Quote';
  if (key.startsWith('oc-'))    return 'Order Confirmation';
  if (key === 'ntp')            return 'NTP';
  return 'Other';
}

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);

  // Check R2 for each template — use head() to get metadata without
  // downloading the whole file. Run all checks in parallel.
  const entries = Object.entries(TEMPLATE_CATALOG);
  const r2Results = await Promise.all(
    entries.map(async ([key, entry]) => {
      try {
        const obj = await env.DOCS.head(entry.r2Key);
        return {
          key,
          ...entry,
          exists: !!obj,
          size: obj?.size ?? 0,
          uploaded: obj?.uploaded?.toISOString?.()?.slice(0, 10) ?? '',
          uploadedBy: obj?.customMetadata?.uploadedBy ?? '',
          originalFilename: obj?.customMetadata?.originalFilename ?? '',
        };
      } catch {
        return { key, ...entry, exists: false, size: 0, uploaded: '', uploadedBy: '', originalFilename: '' };
      }
    })
  );

  const columns = [
    { key: 'label',     label: 'Template',   sort: 'text',   filter: 'text',   default: true },
    { key: 'category',  label: 'Category',   sort: 'text',   filter: 'select', default: true },
    { key: 'status',    label: 'Status',     sort: 'text',   filter: 'select', default: true },
    { key: 'size',      label: 'Size',       sort: 'number', filter: null,     default: true },
    { key: 'uploaded',  label: 'Uploaded',   sort: 'date',   filter: 'text',   default: true },
    { key: 'actions',   label: '',           sort: null,      filter: null,     default: true },
  ];

  const rowData = r2Results.map(t => ({
    id: t.key,
    key: t.key,
    label: t.label,
    filename: t.filename,
    category: templateCategory(t.key),
    status: t.exists ? 'Uploaded' : 'Missing',
    exists: t.exists,
    size: t.size || 0,
    size_display: t.exists ? formatSize(t.size) : '\u2014',
    uploaded: t.uploaded,
    uploadedBy: t.uploadedBy,
    originalFilename: t.originalFilename,
    actions: '',
  }));

  const uploadedCount = rowData.filter(r => r.exists).length;
  const totalCount = rowData.length;

  const body = html`
    ${docsSubNav('templates')}

    <section class="card">
      <div class="card-header">
        <h1 class="page-title">Templates</h1>
        ${listToolbar({ id: 'tpl', count: totalCount, showColumnsMenu: false })}
      </div>

      <p class="muted" style="padding:0 1rem">
        ${uploadedCount} of ${totalCount} templates uploaded.
        Templates are Word .docx files with <code>{placeholder}</code> variables.
      </p>

      <div class="opp-list" data-columns="${escape(JSON.stringify(columns))}">
        <table class="data opp-list-table">
          ${listTableHead(columns, rowData)}
          <tbody data-role="rows">
            ${rowData.map(r => html`
              <tr data-row-id="${escape(r.id)}"
                  ${raw(rowDataAttrs(columns, r))}>
                <td class="col-label" data-col="label">
                  <strong>${escape(r.label)}</strong>
                  <br><small class="muted">${escape(r.filename)}</small>
                </td>
                <td class="col-category" data-col="category">${escape(r.category)}</td>
                <td class="col-status" data-col="status">
                  ${r.exists
                    ? html`<span class="pill pill-success">Uploaded</span>`
                    : html`<span class="pill pill-locked">Missing</span>`}
                </td>
                <td class="col-size num muted" data-col="size" style="font-size:0.85em;white-space:nowrap">
                  ${escape(r.size_display)}
                </td>
                <td class="col-uploaded muted" data-col="uploaded" style="font-size:0.85em;white-space:nowrap">
                  ${r.uploaded ? escape(r.uploaded) : '\u2014'}
                  ${r.uploadedBy ? html`<br><small>${escape(r.uploadedBy)}</small>` : ''}
                </td>
                <td class="col-actions" data-col="actions" style="white-space:nowrap">
                  <div style="display:flex;align-items:center;gap:0.35rem;flex-wrap:wrap">
                    ${r.exists
                      ? html`<a href="/templates/${escape(r.key)}/download" class="btn btn-sm">Download</a>`
                      : ''}
                    <form method="post" action="/templates/${escape(r.key)}/upload"
                          enctype="multipart/form-data"
                          style="display:inline-flex;align-items:center;gap:0.25rem">
                      <input type="file" name="file" accept=".docx"
                             style="font-size:0.8em;max-width:180px">
                      <button type="submit" class="btn btn-sm primary">
                        ${r.exists ? 'Replace' : 'Upload'}
                      </button>
                    </form>
                  </div>
                </td>
              </tr>
            `)}
          </tbody>
        </table>
      </div>
      <script>${raw(listScript('pms.templates.v1', 'label', 'asc'))}</script>
    </section>
  `;

  return htmlResponse(
    layout('Templates', body, {
      user,
      env: data?.env,
      activeNav: '/documents',
      flash: readFlash(url),
      breadcrumbs: [
        { label: 'Documents', href: '/documents/library' },
        { label: 'Templates' },
      ],
    })
  );
}
