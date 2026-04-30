// functions/documents/library.js
//
// GET /documents/library — Document library listing all uploaded documents
// with full sort/filter/column-toggle using the shared list-table controller.

import { all } from '../lib/db.js';
import { layout, htmlResponse, html, raw, escape } from '../lib/layout.js';
import { readFlash } from '../lib/http.js';
import { listScript, listTableHead, listToolbar, rowDataAttrs } from '../lib/list-table.js';
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
  supplier_quote: 'Vendor Quote',
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
      WHERE d.superseded_at IS NULL
      ORDER BY d.uploaded_at DESC
      LIMIT 1000`
  );

  const columns = [
    { key: 'name',        label: 'Name',         sort: 'text',   filter: 'text',   default: true },
    { key: 'kind_label',  label: 'Type',         sort: 'text',   filter: 'select', default: true },
    { key: 'file_type',   label: 'Format',       sort: 'text',   filter: 'select', default: true },
    { key: 'attached_to', label: 'Attached To',  sort: 'text',   filter: 'text',   default: true },
    { key: 'size',        label: 'Size',         sort: 'number', filter: null,     default: true },
    { key: 'date',        label: 'Uploaded',     sort: 'date',   filter: 'text',   default: true },
    { key: 'actions',     label: '',             sort: null,      filter: null,     default: true },
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
      name: d.title || d.original_filename || 'Untitled',
      original_filename: d.original_filename,
      notes: d.notes,
      kind: d.kind || 'other',
      kind_label: DOC_KIND_LABELS[d.kind] || d.kind || '',
      file_type: ft,
      attached_to: attachedTo,
      attached_url: attachedUrl,
      size: d.size_bytes || 0,
      size_display: formatSize(d.size_bytes),
      date: (d.uploaded_at || '').slice(0, 16).replace('T', ' '),
      uploaded_by: d.uploaded_by_name || d.uploaded_by_email || '',
      actions: '',
    };
  });

  const body = html`
    ${docsSubNav('library')}

    <section class="card">
      <div class="card-header">
        <h1 class="page-title">Attachments</h1>
        ${listToolbar({ id: 'dl', count: docs.length, columns })}
      </div>

      ${docs.length === 0
        ? html`<p class="muted" style="padding:1rem">No documents uploaded yet.</p>`
        : html`
          <div class="opp-list" data-columns="${escape(JSON.stringify(columns))}">
            <table class="data opp-list-table" style="table-layout:fixed;width:100%">
              <colgroup>
                <col data-col="name"        style="width:auto">
                <col data-col="kind_label"  style="width:130px">
                <col data-col="file_type"   style="width:80px">
                <col data-col="attached_to" style="width:180px">
                <col data-col="size"        style="width:80px">
                <col data-col="date"        style="width:130px">
                <col data-col="actions"     style="width:260px">
              </colgroup>
              ${listTableHead(columns, rowData)}
              <tbody data-role="rows">
                ${rowData.map(d => html`
                  <tr data-row-id="${escape(d.id)}"
                      ${raw(rowDataAttrs(columns, d))}>
                    <td class="col-name" data-col="name" style="overflow:hidden;text-overflow:ellipsis"
                        x-data="docEdit('${escape(d.id)}', 'title', ${escape(JSON.stringify(d.name))})">
                      <span x-show="!editing" @click="editing = true" style="cursor:pointer">
                        <strong style="border-bottom:1px dashed var(--border)" x-text="val">${escape(d.name)}</strong>
                      </span>
                      <input x-show="editing" x-cloak type="text" :value="val"
                             @blur="save($event.target.value)" @keydown.enter="save($event.target.value)"
                             @keydown.escape="editing = false"
                             x-ref="inp" style="width:100%;font:inherit;padding:0.15rem 0.3rem;font-weight:600"
                             x-effect="if(editing) $nextTick(() => $refs.inp?.focus())">
                      ${d.original_filename && d.original_filename !== d.name
                        ? html`<br><small class="muted">${escape(d.original_filename)}</small>`
                        : ''}
                      ${d.notes ? html`<br><small class="muted">${escape(d.notes)}</small>` : ''}
                    </td>
                    <td class="col-kind_label" data-col="kind_label"
                        x-data="docSelect('${escape(d.id)}', 'kind', '${escape(d.kind)}')">
                      <span x-show="!editing" @click="editing = true" style="cursor:pointer">
                        <span class="pill" style="font-size:0.8em;white-space:nowrap;border-bottom:1px dashed var(--border)" x-text="labels[val] || val">${escape(d.kind_label)}</span>
                      </span>
                      <select x-show="editing" x-cloak x-model="val"
                              @change="save()" @blur="editing = false"
                              x-ref="sel" style="font-size:0.8em;padding:0.15rem 0.3rem"
                              x-effect="if(editing) $nextTick(() => $refs.sel?.focus())">
                        ${Object.entries(DOC_KIND_LABELS).map(([k, v]) =>
                          html`<option value="${escape(k)}">${escape(v)}</option>`)}
                      </select>
                    </td>
                    <td class="col-file_type muted" data-col="file_type" style="font-size:0.85em">${escape(d.file_type)}</td>
                    <td class="col-attached_to" data-col="attached_to" style="overflow:hidden;text-overflow:ellipsis">
                      ${d.attached_url
                        ? html`<a href="${escape(d.attached_url)}">${escape(d.attached_to)}</a>`
                        : html`<span class="muted">\u2014</span>`}
                    </td>
                    <td class="col-size num muted" data-col="size" style="font-size:0.85em;text-align:right">${escape(d.size_display)}</td>
                    <td class="col-date muted" data-col="date" style="font-size:0.85em;white-space:nowrap">
                      ${d.date ? escape(d.date) : '\u2014'}
                      ${d.uploaded_by ? html`<br><small>${escape(d.uploaded_by)}</small>` : ''}
                    </td>
                    <td class="col-actions" data-col="actions" style="text-align:right;white-space:nowrap">
                      <div style="display:inline-flex;align-items:center;gap:0.35rem;justify-content:flex-end">
                        <a href="/documents/${escape(d.id)}/download" target="_blank" rel="noopener" class="btn btn-sm" title="Open in a new tab">Open</a>
                        <a href="/documents/${escape(d.id)}/download?download=1" class="btn btn-sm" title="Force download">Download</a>
                        <form method="post" action="/documents/${escape(d.id)}/replace"
                              enctype="multipart/form-data" style="display:inline">
                          <input type="file" name="file" style="display:none"
                                 onchange="this.form.submit()">
                          <input type="hidden" name="return_to" value="/documents/library">
                          <button type="button" class="btn btn-sm primary"
                                  onclick="this.previousElementSibling.previousElementSibling.click()">Replace</button>
                        </form>
                        <form method="post" action="/documents/${escape(d.id)}/delete"
                              style="display:inline"
                              onsubmit="return confirm('Delete this document?')">
                          <input type="hidden" name="return_to" value="/documents/library">
                          <button type="submit" class="btn btn-sm danger">Delete</button>
                        </form>
                      </div>
                    </td>
                  </tr>
                `)}
              </tbody>
            </table>
          </div>
          <script>${raw(listScript('pipeline.docLib.v2', 'date', 'desc'))}</script>
          <script>
          document.addEventListener('alpine:init', function() {
            var kindLabels = ${raw(JSON.stringify(DOC_KIND_LABELS))};
            Alpine.data('docEdit', function(docId, field, initial) {
              return {
                val: initial, editing: false,
                save: function(v) {
                  this.editing = false;
                  if (v === this.val) return;
                  this.val = v;
                  fetch('/documents/' + docId + '/patch', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ field: field, value: v }),
                  });
                },
              };
            });
            Alpine.data('docSelect', function(docId, field, initial) {
              return {
                val: initial, editing: false, labels: kindLabels,
                save: function() {
                  var v = this.val;
                  this.editing = false;
                  fetch('/documents/' + docId + '/patch', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ field: field, value: v }),
                  });
                },
              };
            });
          });
          </script>`}
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
