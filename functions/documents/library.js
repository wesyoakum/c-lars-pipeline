// functions/documents/library.js
//
// GET /documents/library — Document library listing all uploaded documents
// with full sort/filter/column-toggle using the shared list-table controller.

import { all } from '../lib/db.js';
import { layout, htmlResponse, html, raw, escape } from '../lib/layout.js';
import { readFlash } from '../lib/http.js';
import { listScript, listTableHead, listToolbar, columnsMenu, rowDataAttrs } from '../lib/list-table.js';
import { docsSubNav } from '../lib/docs-subnav.js';

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
  if (!bytes) return '\u2014';
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
  if (!mime) return '\uD83D\uDCCE';
  if (mime.includes('pdf')) return '\uD83D\uDCC4';
  if (mime.includes('word') || mime.includes('docx')) return '\uD83D\uDCDD';
  if (mime.includes('image/')) return '\uD83D\uDDBC\uFE0F';
  if (mime.includes('spreadsheet') || mime.includes('xlsx') || mime.includes('excel')) return '\uD83D\uDCCA';
  return '\uD83D\uDCCE';
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

  const columns = [
    { key: 'name',        label: 'Name',        sort: 'text',   filter: 'text',   default: true },
    { key: 'kind_label',  label: 'Type',        sort: 'text',   filter: 'select', default: true },
    { key: 'file_type',   label: 'Format',      sort: 'text',   filter: 'select', default: true },
    { key: 'attached_to', label: 'Attached To',  sort: 'text',   filter: 'text',   default: true },
    { key: 'account_name',label: 'Account',      sort: 'text',   filter: 'select', default: true },
    { key: 'size',        label: 'Size',         sort: 'number', filter: null,     default: true },
    { key: 'date',        label: 'Uploaded',     sort: 'date',   filter: 'text',   default: true },
    { key: 'uploaded_by', label: 'By',           sort: 'text',   filter: 'text',   default: true },
  ];

  const rowData = docs.map(d => {
    const ft = fileTypeFromMime(d.mime_type);
    let attachedTo = '';
    let attachedUrl = '';
    if (d.quote_id && d.quote_number) {
      attachedTo = `${d.quote_number} Rev ${d.quote_revision || ''}`;
      attachedUrl = `/opportunities/${d.opportunity_id}/quotes/${d.quote_id}`;
    } else if (d.job_id && d.job_number) {
      attachedTo = d.job_number;
      attachedUrl = `/jobs/${d.job_id}`;
    } else if (d.opportunity_id && d.opp_number) {
      attachedTo = `${d.opp_number}${d.opp_title ? ' \u2014 ' + d.opp_title : ''}`;
      attachedUrl = `/opportunities/${d.opportunity_id}`;
    } else if (d.account_id && d.account_name) {
      attachedTo = d.account_name;
      attachedUrl = `/accounts/${d.account_id}`;
    }
    return {
      id: d.id,
      icon: fileIcon(d.mime_type),
      name: d.title || d.original_filename || 'Untitled',
      original_filename: d.original_filename,
      notes: d.notes,
      kind: d.kind,
      kind_label: DOC_KIND_LABELS[d.kind] || d.kind || '',
      file_type: ft,
      attached_to: attachedTo,
      attached_url: attachedUrl,
      account_name: d.account_name ?? '',
      account_id: d.account_id,
      size: d.size_bytes || 0,
      size_display: formatSize(d.size_bytes),
      date: (d.uploaded_at || '').slice(0, 10),
      uploaded_by: d.uploaded_by_name || d.uploaded_by_email || '\u2014',
    };
  });

  const body = html`
    ${docsSubNav('library')}

    <section class="card">
      <div class="card-header">
        <h1 class="page-title">Documents</h1>
        ${listToolbar({ id: 'dl', count: docs.length })}
      </div>

      ${docs.length === 0
        ? html`<p class="muted" style="padding:1rem">No documents uploaded yet.</p>`
        : html`
          <div class="opp-list" data-columns="${escape(JSON.stringify(columns))}">
            ${columnsMenu(columns)}
            <table class="data opp-list-table">
              ${listTableHead(columns, rowData)}
              <tbody data-role="rows">
                ${rowData.map(d => html`
                  <tr data-row-id="${escape(d.id)}"
                      ${raw(rowDataAttrs(columns, d))}>
                    <td class="col-name" data-col="name">
                      <a href="/documents/${escape(d.id)}/download">${escape(d.name)}</a>
                      ${d.original_filename && d.original_filename !== d.name
                        ? html`<br><small class="muted">${escape(d.original_filename)}</small>`
                        : ''}
                      ${d.notes ? html`<br><small class="muted">${escape(d.notes)}</small>` : ''}
                    </td>
                    <td class="col-kind_label" data-col="kind_label"><span class="pill" style="font-size:0.8em">${escape(d.kind_label)}</span></td>
                    <td class="col-file_type muted" data-col="file_type" style="font-size:0.85em">${escape(d.file_type)}</td>
                    <td class="col-attached_to" data-col="attached_to">
                      ${d.attached_url
                        ? html`<a href="${escape(d.attached_url)}">${escape(d.attached_to)}</a>`
                        : html`<span class="muted">\u2014</span>`}
                    </td>
                    <td class="col-account_name" data-col="account_name">${d.account_id ? html`<a href="/accounts/${escape(d.account_id)}">${escape(d.account_name)}</a>` : html`<span class="muted">\u2014</span>`}</td>
                    <td class="col-size num muted" data-col="size" style="font-size:0.85em;white-space:nowrap">${escape(d.size_display)}</td>
                    <td class="col-date muted" data-col="date" style="font-size:0.85em;white-space:nowrap">${escape(d.date)}</td>
                    <td class="col-uploaded_by muted" data-col="uploaded_by" style="font-size:0.85em">${escape(d.uploaded_by)}</td>
                  </tr>
                `)}
              </tbody>
            </table>
          </div>
          <script>${raw(listScript('pms.docLib.v1', 'date', 'desc'))}</script>`}
    </section>
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
