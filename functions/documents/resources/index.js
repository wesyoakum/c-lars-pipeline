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

      <!-- Upload form -->
      <form method="post" action="/documents/resources" enctype="multipart/form-data"
            style="padding:0.5rem 1rem 1rem;display:flex;align-items:flex-end;gap:0.75rem;flex-wrap:wrap;border-bottom:1px solid var(--border)">
        <div class="field" style="min-width:180px;flex:1">
          <label>Title</label>
          <input type="text" name="title" placeholder="Document title (or auto from filename)">
        </div>
        <div class="field" style="min-width:120px">
          <label>Category</label>
          <select name="category">
            ${raw(catOptions)}
          </select>
        </div>
        <div class="field" style="min-width:120px">
          <label>Notes <small class="muted">(optional)</small></label>
          <input type="text" name="notes" placeholder="Brief description">
        </div>
        <div style="display:flex;align-items:center;gap:0.5rem;padding-bottom:0.15rem">
          <input type="file" name="file" id="res-file-input" style="display:none"
                 onchange="document.getElementById('res-file-label').textContent = this.files[0]?.name || 'Choose file'">
          <button type="button" class="btn btn-sm"
                  onclick="document.getElementById('res-file-input').click()"
                  id="res-file-label">Choose file</button>
          <button type="submit" class="btn btn-sm primary">Upload</button>
        </div>
      </form>

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
                <col data-col="actions"        style="width:190px">
              </colgroup>
              ${listTableHead(columns, rowData)}
              <tbody data-role="rows">
                ${rowData.map(r => html`
                  <tr data-row-id="${escape(r.id)}"
                      ${raw(rowDataAttrs(columns, r))}>
                    <td class="col-title" data-col="title" style="overflow:hidden;text-overflow:ellipsis">
                      <strong>${escape(r.title)}</strong>
                      ${r.original_filename && r.original_filename !== r.title
                        ? html`<br><small class="muted">${escape(r.original_filename)}</small>`
                        : ''}
                      ${r.notes ? html`<br><small class="muted">${escape(r.notes)}</small>` : ''}
                    </td>
                    <td class="col-category_label" data-col="category_label">
                      <span class="pill" style="font-size:0.8em">${escape(r.category_label)}</span>
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
  return Response.redirect(url, 303);
}
