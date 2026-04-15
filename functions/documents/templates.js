// functions/documents/templates.js
//
// GET /documents/templates — Template manager page.
// Lists every template from the catalog, shows which ones exist in R2
// (with size / last-modified), and provides download + upload/replace
// all inline in a single row per template.

import { all } from '../lib/db.js';
import { layout, htmlResponse, html, raw, escape } from '../lib/layout.js';
import { readFlash } from '../lib/http.js';
import { TEMPLATE_CATALOG } from '../lib/template-catalog.js';
import { listScript, listTableHead, listToolbar, rowDataAttrs } from '../lib/list-table.js';
import { docsSubNav } from '../lib/docs-subnav.js';
import {
  listFilenameTemplates,
  renderFilenameTemplate,
  FILENAME_TOKENS,
  FILENAME_PREVIEW_CONTEXT,
} from '../lib/filename-templates.js';

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
          customLabel: obj?.customMetadata?.customLabel ?? '',
        };
      } catch {
        return { key, ...entry, exists: false, size: 0, uploaded: '', uploadedBy: '', originalFilename: '', customLabel: '' };
      }
    })
  );

  // Resolve uploader emails to display names
  const uploaderEmails = [...new Set(r2Results.map(t => t.uploadedBy).filter(Boolean))];
  let emailToName = {};
  if (uploaderEmails.length) {
    const placeholders = uploaderEmails.map(() => '?').join(',');
    const users = await all(env.DB,
      `SELECT email, display_name FROM users WHERE email IN (${placeholders})`,
      uploaderEmails);
    emailToName = Object.fromEntries(users.map(u => [u.email, u.display_name || u.email]));
  }

  // Load filename conventions (one row per template catalog key, keyed by
  // template_catalog key — see migration 0025). Map them onto each
  // template row so the inline editor has a starting value.
  const filenameRows = await listFilenameTemplates(env);
  const filenameByKey = Object.fromEntries(
    filenameRows.map((r) => [r.key, r.template || ''])
  );

  const columns = [
    { key: 'label',       label: 'Template',   sort: 'text',   filter: 'text',   default: true },
    { key: 'category',    label: 'Category',   sort: 'text',   filter: 'select', default: true },
    { key: 'status',      label: 'Status',     sort: 'text',   filter: 'select', default: true },
    { key: 'filenameTpl', label: 'Download filename', sort: 'text', filter: 'text', default: true },
    { key: 'size',        label: 'Size',       sort: 'number', filter: null,     default: true },
    { key: 'uploaded',    label: 'Uploaded',   sort: 'date',   filter: 'text',   default: true },
    { key: 'actions',     label: '',           sort: null,      filter: null,     default: true },
  ];

  const rowData = r2Results.map(t => {
    const filenameTpl = filenameByKey[t.key] || '';
    return {
      id: t.key,
      key: t.key,
      label: t.customLabel || t.label,
      filename: t.filename,
      category: templateCategory(t.key),
      status: t.exists ? 'Uploaded' : 'Missing',
      exists: t.exists,
      size: t.size || 0,
      size_display: t.exists ? formatSize(t.size) : '\u2014',
      uploaded: t.uploaded,
      uploadedBy: emailToName[t.uploadedBy] || t.uploadedBy,
      originalFilename: t.originalFilename,
      filenameTpl,
      filenamePreview: renderFilenameTemplate(filenameTpl, FILENAME_PREVIEW_CONTEXT),
      actions: '',
    };
  });

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
        Each template also has a <strong>download filename convention</strong>
        (inline-editable below) that controls what the file is called when it's generated —
        <code>.pdf</code> / <code>.docx</code> is appended automatically.
      </p>

      <details class="token-cheat" style="margin:0 1rem 0.75rem;font-size:0.9em">
        <summary style="cursor:pointer;color:var(--muted)">Available filename tokens</summary>
        <ul style="margin:0.4rem 0 0 1.25rem;padding:0;line-height:1.55">
          ${FILENAME_TOKENS.map((t) => html`
            <li>
              <code>{${escape(t.token)}}</code>
              <span class="muted"> — ${escape(t.label)}</span>
            </li>
          `)}
        </ul>
      </details>

      <!-- Upload drop zone -->
      <div x-data="tplUpload()" style="margin:0.75rem 1rem">
        <form x-ref="uploadForm" enctype="multipart/form-data" method="post"
              :action="'/templates/' + selectedKey + '/upload'">
          <div class="drop-zone" :class="{ 'drop-zone-active': dragging }"
               @dragover.prevent="dragging = true"
               @dragleave.prevent="dragging = false"
               @drop.prevent="handleDrop($event)"
               @click="$refs.fileInput.click()">
            <input type="file" name="file" accept=".docx" required x-ref="fileInput" hidden @change="fileSelected($event)">
            <div class="drop-zone-content">
              <span x-show="!fileName" class="muted">Drop .docx template here or click to browse</span>
              <span x-show="fileName" x-text="fileName" style="font-weight:500"></span>
            </div>
          </div>
          <div x-show="fileName" x-cloak style="margin-top:0.4rem;display:flex;gap:0.5rem;align-items:center">
            <label class="muted" style="font-size:0.85em;white-space:nowrap">Upload as:</label>
            <select x-model="selectedKey" style="font-size:0.85em">
              ${rowData.map(r => html`<option value="${escape(r.key)}">${escape(r.label)}</option>`)}
            </select>
            <button class="btn btn-sm primary" type="submit">Upload</button>
            <button class="btn btn-sm" type="button" @click="clear()">Cancel</button>
          </div>
        </form>
      </div>
      <script>${raw(`
function tplUpload() {
  return {
    dragging: false,
    fileName: '',
    selectedKey: '${rowData[0]?.key || ''}',
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

      <div class="opp-list" data-columns="${escape(JSON.stringify(columns))}">
        <table class="data opp-list-table" style="table-layout:fixed;width:100%">
          <colgroup>
            <col data-col="label"       style="width:auto">
            <col data-col="category"    style="width:125px">
            <col data-col="status"      style="width:85px">
            <col data-col="filenameTpl" style="width:230px">
            <col data-col="size"        style="width:60px">
            <col data-col="uploaded"    style="width:110px">
            <col data-col="actions"     style="width:210px">
          </colgroup>
          ${listTableHead(columns, rowData)}
          <tbody data-role="rows">
            ${rowData.map(r => html`
              <tr data-row-id="${escape(r.id)}"
                  ${raw(rowDataAttrs(columns, r))}>
                <td class="col-label" data-col="label" style="overflow:hidden;text-overflow:ellipsis"
                    x-data="tplEdit('${escape(r.key)}', 'label', ${escape(JSON.stringify(r.label))})">
                  <span x-show="!editing" @click="editing = true" style="cursor:pointer">
                    <strong style="border-bottom:1px dashed var(--border)" x-text="val">${escape(r.label)}</strong>
                  </span>
                  <input x-show="editing" x-cloak type="text" :value="val"
                         @blur="save($event.target.value)" @keydown.enter="save($event.target.value)"
                         @keydown.escape="editing = false"
                         x-ref="inp" style="width:100%;font:inherit;padding:0.15rem 0.3rem;font-weight:600"
                         x-effect="if(editing) $nextTick(() => $refs.inp?.focus())">
                  <br><small class="muted">${escape(r.originalFilename || r.filename)}</small>
                </td>
                <td class="col-category" data-col="category">${escape(r.category)}</td>
                <td class="col-status" data-col="status" style="text-align:center">
                  ${r.exists
                    ? html`<span class="pill pill-success">Uploaded</span>`
                    : html`<span class="pill pill-locked">Missing</span>`}
                </td>
                <td class="col-filenameTpl" data-col="filenameTpl" style="vertical-align:top"
                    x-data="filenameEdit('${escape(r.key)}', ${escape(JSON.stringify(r.filenameTpl))}, ${escape(JSON.stringify(FILENAME_PREVIEW_CONTEXT))})">
                  <input type="text" x-model="val"
                         @blur="save()"
                         @keydown.enter.prevent="save(); $event.target.blur()"
                         @keydown.escape="val = initial; $event.target.blur()"
                         placeholder="e.g. C-LARS Quote {quoteNumber}"
                         style="width:100%;font:inherit;padding:0.3rem 0.45rem;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.85em">
                  <div style="margin-top:0.2rem;font-size:0.78em;color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
                       x-text="previewLine()"
                       :title="previewLine()"></div>
                  <small class="muted" x-show="dirty" x-cloak style="font-size:0.75em">unsaved…</small>
                  <small class="pill pill-success" x-show="saved" x-cloak
                         x-transition.opacity.duration.600ms
                         style="font-size:0.72em;margin-top:0.15rem;display:inline-block">saved</small>
                </td>
                <td class="col-size num muted" data-col="size" style="font-size:0.85em;text-align:right">
                  ${escape(r.size_display)}
                </td>
                <td class="col-uploaded muted" data-col="uploaded" style="font-size:0.85em;white-space:nowrap">
                  ${r.uploaded ? escape(r.uploaded) : '\u2014'}
                  ${r.uploadedBy ? html`<br><small>${escape(r.uploadedBy)}</small>` : ''}
                </td>
                <td class="col-actions" data-col="actions" style="text-align:right;white-space:nowrap">
                  <div style="display:inline-flex;align-items:center;gap:0.35rem;justify-content:flex-end">
                    ${r.exists
                      ? html`<a href="/templates/${escape(r.key)}/download" class="btn btn-sm">Download</a>`
                      : ''}
                    <form method="post" action="/templates/${escape(r.key)}/upload"
                          enctype="multipart/form-data" style="display:inline">
                      <input type="file" name="file" accept=".docx"
                             style="display:none"
                             onchange="this.form.submit()">
                      <button type="button" class="btn btn-sm primary"
                              onclick="this.previousElementSibling.click()">
                        ${r.exists ? 'Replace' : 'Upload'}
                      </button>
                    </form>
                    ${r.exists
                      ? html`<form method="post" action="/templates/${escape(r.key)}/delete"
                                   style="display:inline"
                                   onsubmit="return confirm('Delete this template?')">
                               <button type="submit" class="btn btn-sm danger">Delete</button>
                             </form>`
                      : ''}
                  </div>
                </td>
              </tr>
            `)}
          </tbody>
        </table>
      </div>
      <script>${raw(listScript('pms.templates.v1', 'label', 'asc'))}</script>
      <script>${raw(`
      document.addEventListener('alpine:init', function() {
        Alpine.data('tplEdit', function(tplKey, field, initial) {
          return {
            val: initial, editing: false,
            save: function(v) {
              this.editing = false;
              if (v === this.val) return;
              this.val = v;
              fetch('/templates/' + tplKey + '/patch', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ field: field, value: v }),
              });
            },
          };
        });

        // Inline edit for the download-filename convention on each row.
        // Saves to /documents/filenames/:key/patch. Preview mirrors
        // renderFilenameTemplate() server-side so what you see matches
        // what the generator produces exactly.
        Alpine.data('filenameEdit', function(key, initial, previewCtx) {
          return {
            key: key,
            initial: initial,
            val: initial,
            saved: false,
            get dirty() { return this.val !== this.initial; },
            previewLine: function() {
              var rendered = renderFilenamePreview(this.val, previewCtx);
              return rendered ? '\u2192 ' + rendered : '';
            },
            save: function() {
              if (this.val === this.initial) return;
              var self = this;
              var payload = this.val;
              fetch('/documents/filenames/' + encodeURIComponent(this.key) + '/patch', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ template: payload }),
              }).then(function(res) {
                if (!res.ok) {
                  self.val = self.initial;
                  return;
                }
                self.initial = payload;
                self.saved = true;
                setTimeout(function() { self.saved = false; }, 1200);
              }).catch(function() {
                self.val = self.initial;
              });
            },
          };
        });
      });

      // Mirror of renderFilenameTemplate in functions/lib/filename-templates.js
      // so the live preview exactly matches what the server will render.
      function renderFilenamePreview(template, context) {
        if (!template) return '';
        var rendered = template.replace(/\\{(\\w+)\\}/g, function(_m, token) {
          var v = context && context[token];
          if (v == null) return '';
          return String(v);
        });
        return rendered
          .replace(/[\\\\/:*?"<>|]/g, '')
          .replace(/\\s+/g, ' ')
          .trim();
      }
      `)}</script>
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
