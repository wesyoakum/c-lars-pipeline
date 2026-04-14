// functions/documents/resources/index.js
//
// GET  /documents/resources — Resource library page.
// POST /documents/resources — Upload a new resource.
//
// General-purpose company documents: NDAs, governing documents,
// checklists, reference guides, etc. Not tied to any opportunity.

import { all, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { uuid, now } from '../../lib/ids.js';
import { layout, htmlResponse, html, raw, escape } from '../../lib/layout.js';
import { readFlash } from '../../lib/http.js';
import { listScript, listTableHead, listToolbar, rowDataAttrs } from '../../lib/list-table.js';
import { docsSubNav } from '../../lib/docs-subnav.js';

const MAX_SIZE = 50 * 1024 * 1024; // 50 MB

const CATEGORIES = {
  legal:      'Legal',
  reference:  'Reference',
  checklist:  'Checklist',
  form:       'Form / Template',
  other:      'Other',
};

function formatSize(bytes) {
  if (!bytes) return '\u2014';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);

  const rows = await all(
    env.DB,
    `SELECT r.*, u.display_name AS uploaded_by_name, u.email AS uploaded_by_email
       FROM resources r
       LEFT JOIN users u ON u.id = r.uploaded_by_user_id
      ORDER BY r.title`
  );

  const columns = [
    { key: 'title',          label: 'Name',      sort: 'text',   filter: 'text',   default: true },
    { key: 'category_label', label: 'Category',  sort: 'text',   filter: 'select', default: true },
    { key: 'size',           label: 'Size',      sort: 'number', filter: null,     default: true },
    { key: 'uploaded',       label: 'Uploaded',  sort: 'date',   filter: 'text',   default: true },
    { key: 'actions',        label: '',          sort: null,      filter: null,     default: true },
  ];

  const rowData = rows.map(r => ({
    id: r.id,
    title: r.title || r.original_filename || 'Untitled',
    original_filename: r.original_filename || '',
    notes: r.notes || '',
    category: r.category || 'other',
    category_label: CATEGORIES[r.category] || r.category || 'Other',
    size: r.size_bytes || 0,
    size_display: formatSize(r.size_bytes),
    uploaded: (r.uploaded_at || '').slice(0, 10),
    uploaded_by: r.uploaded_by_name || r.uploaded_by_email || '\u2014',
    actions: '',
  }));

  const catOptions = Object.entries(CATEGORIES).map(
    ([v, l]) => `<option value="${v}">${l}</option>`
  ).join('');

  const body = html`
    ${docsSubNav('resources')}

    <section class="card">
      <div class="card-header">
        <h1 class="page-title">Resources</h1>
        ${listToolbar({ id: 'res', count: rows.length, showColumnsMenu: false })}
      </div>

      <p class="muted" style="padding:0 1rem">
        Company reference documents &mdash; NDAs, governing documents, checklists, reference guides, and other shared files.
      </p>

      <!-- Upload drop zone -->
      <div x-data="resUpload()" style="margin:0.75rem 1rem">
        <form method="post" action="/documents/resources" enctype="multipart/form-data" x-ref="uploadForm">
          <div class="drop-zone" :class="{ 'drop-zone-active': dragging }"
               @dragover.prevent="dragging = true"
               @dragleave.prevent="dragging = false"
               @drop.prevent="handleDrop($event)"
               @click="$refs.fileInput.click()">
            <input type="file" name="file" required x-ref="fileInput" hidden @change="fileSelected($event)">
            <div class="drop-zone-content">
              <span x-show="!fileName" class="muted">Drop file here or click to browse</span>
              <span x-show="fileName" x-text="fileName" style="font-weight:500"></span>
            </div>
          </div>
          <div x-show="fileName" x-cloak style="margin-top:0.4rem;display:flex;gap:0.5rem;align-items:center">
            <input type="text" name="title" placeholder="Title (defaults to filename)" style="flex:1;font-size:0.85em">
            <select name="category" style="font-size:0.85em">
              ${raw(catOptions)}
            </select>
            <button class="btn btn-sm primary" type="submit">Upload</button>
            <button class="btn btn-sm" type="button" @click="clear()">Cancel</button>
          </div>
        </form>
      </div>
      <script>${raw(`
function resUpload() {
  return {
    dragging: false,
    fileName: '',
    handleDrop(e) {
      this.dragging = false;
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) {
        this.$refs.fileInput.files = files;
        this.fileName = files[0].name;
      }
    },
    fileSelected(e) {
      var f = e.target.files && e.target.files[0];
      this.fileName = f ? f.name : '';
    },
    clear() {
      this.$refs.fileInput.value = '';
      this.fileName = '';
    },
  };
}
      `)}</script>

      ${rows.length === 0
        ? html`<p class="muted" style="padding:1rem">No resources uploaded yet.</p>`
        : html`
          <div class="opp-list" data-columns="${escape(JSON.stringify(columns))}">
            <table class="data opp-list-table" style="table-layout:fixed;width:100%">
              <colgroup>
                <col data-col="title"          style="width:auto">
                <col data-col="category_label" style="width:150px">
                <col data-col="size"           style="width:80px">
                <col data-col="uploaded"       style="width:130px">
                <col data-col="actions"        style="width:260px">
              </colgroup>
              ${listTableHead(columns, rowData)}
              <tbody data-role="rows">
                ${rowData.map(r => html`
                  <tr data-row-id="${escape(r.id)}"
                      ${raw(rowDataAttrs(columns, r))}>
                    <td class="col-title" data-col="title" style="overflow:hidden;text-overflow:ellipsis"
                        x-data="resEdit('${escape(r.id)}', 'title', ${raw(JSON.stringify(r.title))})">
                      <span x-show="!editing" @click="editing = true" style="cursor:pointer">
                        <strong style="border-bottom:1px dashed var(--border)" x-text="val">${escape(r.title)}</strong>
                      </span>
                      <input x-show="editing" x-cloak type="text" :value="val"
                             @blur="save($event.target.value)" @keydown.enter="save($event.target.value)"
                             @keydown.escape="editing = false"
                             x-ref="inp" style="width:100%;font:inherit;padding:0.15rem 0.3rem;font-weight:600"
                             x-effect="if(editing) $nextTick(() => $refs.inp?.focus())">
                      ${r.original_filename && r.original_filename !== r.title
                        ? html`<br><small class="muted">${escape(r.original_filename)}</small>`
                        : ''}
                      ${r.notes ? html`<br><small class="muted">${escape(r.notes)}</small>` : ''}
                    </td>
                    <td class="col-category_label" data-col="category_label"
                        x-data="resSelect('${escape(r.id)}', 'category', '${escape(r.category)}')">
                      <span x-show="!editing" @click="editing = true" style="cursor:pointer">
                        <span class="pill" style="font-size:0.8em;border-bottom:1px dashed var(--border)" x-text="labels[val] || val">${escape(r.category_label)}</span>
                      </span>
                      <select x-show="editing" x-cloak x-model="val"
                              @change="save()" @blur="editing = false"
                              x-ref="sel" style="font-size:0.8em;padding:0.15rem 0.3rem"
                              x-effect="if(editing) $nextTick(() => $refs.sel?.focus())">
                        ${Object.entries(CATEGORIES).map(([k, v]) =>
                          html`<option value="${escape(k)}">${escape(v)}</option>`)}
                      </select>
                    </td>
                    <td class="col-size num muted" data-col="size" style="font-size:0.85em;text-align:right">
                      ${escape(r.size_display)}
                    </td>
                    <td class="col-uploaded muted" data-col="uploaded" style="font-size:0.85em;white-space:nowrap">
                      ${r.uploaded ? escape(r.uploaded) : '\u2014'}
                      ${r.uploaded_by ? html`<br><small>${escape(r.uploaded_by)}</small>` : ''}
                    </td>
                    <td class="col-actions" data-col="actions" style="text-align:right;white-space:nowrap">
                      <div style="display:inline-flex;align-items:center;gap:0.35rem;justify-content:flex-end">
                        <a href="/documents/resources/${escape(r.id)}/download" class="btn btn-sm">Download</a>
                        <form method="post" action="/documents/resources/${escape(r.id)}/replace"
                              enctype="multipart/form-data" style="display:inline">
                          <input type="file" name="file" style="display:none"
                                 onchange="this.form.submit()">
                          <button type="button" class="btn btn-sm primary"
                                  onclick="this.previousElementSibling.click()">Replace</button>
                        </form>
                        <form method="post" action="/documents/resources/${escape(r.id)}/delete"
                              style="display:inline"
                              onsubmit="return confirm('Delete this resource?')">
                          <button type="submit" class="btn btn-sm danger">Delete</button>
                        </form>
                      </div>
                    </td>
                  </tr>
                `)}
              </tbody>
            </table>
          </div>
          <script>${raw(listScript('pms.resources.v1', 'title', 'asc'))}</script>
          <script>
          document.addEventListener('alpine:init', function() {
            var catLabels = ${raw(JSON.stringify(CATEGORIES))};
            Alpine.data('resEdit', function(resId, field, initial) {
              return {
                val: initial, editing: false,
                save: function(v) {
                  this.editing = false;
                  if (v === this.val) return;
                  this.val = v;
                  fetch('/documents/resources/' + resId + '/patch', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ field: field, value: v }),
                  });
                },
              };
            });
            Alpine.data('resSelect', function(resId, field, initial) {
              return {
                val: initial, editing: false, labels: catLabels,
                save: function() {
                  var v = this.val;
                  this.editing = false;
                  fetch('/documents/resources/' + resId + '/patch', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ field: field, value: v }),
                  });
                },
              };
            });
          });
          </script>
        `}
    </section>
  `;

  return htmlResponse(
    layout('Resources', body, {
      user,
      env: data?.env,
      activeNav: '/documents',
      flash: readFlash(url),
      breadcrumbs: [
        { label: 'Documents', href: '/documents/library' },
        { label: 'Resources' },
      ],
    })
  );
}

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return redirect('Invalid form data.', 'error');
  }

  const file = formData.get('file');
  const category = formData.get('category') || 'other';
  const titleInput = (formData.get('title') || '').trim();
  const notes = (formData.get('notes') || '').trim() || null;

  if (!file || typeof file === 'string' || file.size === 0) {
    return redirect('No file selected.', 'error');
  }

  if (file.size > MAX_SIZE) {
    return redirect('File exceeds 50 MB limit.', 'error');
  }

  const id = uuid();
  const ts = now();
  const originalFilename = file.name || 'file';
  const derivedTitle = originalFilename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
  const title = titleInput || derivedTitle;

  // Safe filename for R2 key
  const safeName = (originalFilename)
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'file';
  const r2Key = `resources/${id}-${safeName}`;

  // Upload to R2
  const buffer = await file.arrayBuffer();
  await env.DOCS.put(r2Key, buffer, {
    httpMetadata: {
      contentType: file.type || 'application/octet-stream',
    },
    customMetadata: {
      resourceId: id,
      uploadedBy: user?.email ?? 'unknown',
      originalFilename,
    },
  });

  // Write to D1
  await batch(env.DB, [
    stmt(env.DB,
      `INSERT INTO resources
         (id, title, category, original_filename, r2_key, mime_type, size_bytes, notes,
          uploaded_at, uploaded_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, title, category, originalFilename, r2Key,
       file.type || 'application/octet-stream', file.size, notes, ts, user?.id]
    ),
    auditStmt(env.DB, {
      entityType: 'resource',
      entityId: id,
      eventType: 'uploaded',
      user,
      summary: `Uploaded resource: ${title} (${formatSize(file.size)})`,
    }),
  ]);

  return redirect(`Uploaded: ${title}`);
}

function redirect(message, level = 'success') {
  const url = `/documents/resources?flash=${encodeURIComponent(message)}&flash_level=${level}`;
  return new Response(null, { status: 303, headers: { Location: url } });
}
