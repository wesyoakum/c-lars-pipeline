// functions/sandbox/assistant/inbox.js
//
// GET /sandbox/assistant/inbox
//
// Full-page table view of every dropped document (the "View all →"
// target from the right-sidebar on /sandbox/assistant). Uses the
// project's standard list-table machinery (see /jobs, /accounts, etc.)
// so we get free quicksearch, per-column filters, sort, column
// show/hide, and persistence.
//
// Wes-only — same email gate as the rest of /sandbox/assistant.

import { all } from '../../lib/db.js';
import { layout, htmlResponse, html, raw, escape } from '../../lib/layout.js';
import { listScript, listTableHead, listToolbar, rowDataAttrs } from '../../lib/list-table.js';

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';

export async function onRequestGet(context) {
  const { env, data } = context;
  const user = data?.user;
  if (!user || user.email !== SANDBOX_OWNER) {
    return new Response('Not found', { status: 404 });
  }

  // Pull every non-trashed doc with the parent's subject/filename
  // joined in for the "Email" column (only meaningful on attachment
  // rows). 500-row cap matches /jobs.
  const rows = await all(
    env.DB,
    `SELECT d.id, d.filename, d.content_type, d.size_bytes, d.retention,
            d.extraction_status, d.extraction_error, d.created_at,
            d.category,
            d.sender_email, d.sender_name, d.subject, d.email_date,
            d.parent_id,
            p.subject  AS parent_subject,
            p.filename AS parent_filename
       FROM claudia_documents d
       LEFT JOIN claudia_documents p ON p.id = d.parent_id
      WHERE d.user_id = ? AND d.retention != 'trashed'
      ORDER BY COALESCE(d.email_date, d.created_at) DESC
      LIMIT 500`,
    [user.id]
  );

  const columns = [
    { key: 'subject',  label: 'Subject / File', sort: 'text',   filter: 'text',   default: true },
    { key: 'sender',   label: 'From',           sort: 'text',   filter: 'text',   default: true },
    { key: 'category', label: 'Category',       sort: 'text',   filter: 'select', default: true },
    { key: 'date',     label: 'Date',           sort: 'date',   filter: 'text',   default: true },
    { key: 'size',     label: 'Size',           sort: 'numeric',filter: 'text',   default: true },
    { key: 'type',     label: 'Type',           sort: 'text',   filter: 'select', default: false },
    { key: 'parent',   label: 'Email',          sort: 'text',   filter: 'text',   default: false },
    { key: 'actions',  label: '',               sort: null,     filter: null,     default: true },
  ];

  const rowData = rows.map((r) => {
    const isEmail = !!r.subject || isEmailType(r.content_type, r.filename);
    const isChild = !!r.parent_id;

    const subjectText = r.subject || r.filename || 'untitled';
    const sender = r.sender_name || r.sender_email || '';
    const dateIso = r.email_date || r.created_at || '';
    const typeShort = contentTypeShort(r.content_type, r.filename);
    const sizeLabel = formatBytes(r.size_bytes);
    const sizeRaw = Number.isFinite(r.size_bytes) ? r.size_bytes : 0;

    const parentLabel = isChild
      ? (r.parent_subject || r.parent_filename || '(parent)')
      : '';

    // The values stored at column-keyed properties drive sort/filter via
    // rowDataAttrs (data-{key}="..."). Display-only formats (e.g. the
    // human-readable "1.2 MB") live alongside under different keys and
    // are rendered into the cell directly.
    return {
      id: r.id,
      subject: isChild ? (r.filename || '') : subjectText,
      sender,
      category: r.category || '',
      date: dateIso,            // ISO 8601 — sorts correctly as string
      date_display: dateIso ? dateIso.slice(0, 10) : '',
      size: sizeRaw,            // raw bytes — numeric sort works
      size_display: sizeLabel,
      type: typeShort,
      parent: parentLabel,
      parent_id: r.parent_id || '',
      retention: r.retention || 'auto',
      kind: isEmail && !isChild ? 'email' : (isChild ? 'attachment' : 'doc'),
    };
  });

  const body = html`
    <section class="card">
      <div class="card-header">
        <h1 class="page-title">Inbox</h1>
        ${listToolbar({ id: 'claudia-inbox', count: rows.length, columns })}
      </div>

      <p class="muted" style="margin: 0 0 0.6rem 0;">
        Every document Claudia has seen — emails, attachments, PDFs, recordings.
        <a href="/sandbox/assistant">← Back to Claudia</a>
      </p>

      ${rows.length === 0
        ? html`<p class="muted">No documents yet. Drop files on <a href="/sandbox/assistant">Claudia's chat</a> to start.</p>`
        : html`
          <div class="opp-list" data-columns="${escape(JSON.stringify(columns))}">
            <table class="data opp-list-table">
              ${listTableHead(columns, rowData)}
              <tbody data-role="rows">
                ${rowData.map(r => html`
                  <tr data-row-id="${escape(r.id)}"
                      ${raw(rowDataAttrs(columns, r))}>
                    <td class="col-subject" data-col="subject">
                      ${r.kind === 'attachment' ? raw('<span class="muted" title="Attachment">↳</span> ') : ''}
                      <strong>${escape(r.subject)}</strong>
                    </td>
                    <td class="col-sender" data-col="sender">${escape(r.sender)}</td>
                    <td class="col-category" data-col="category">
                      ${r.category
                        ? html`<span class="claudia-doc-badge cat cat-${escape(r.category)}">${escape(r.category)}</span>`
                        : ''}
                    </td>
                    <td class="col-date" data-col="date">
                      <small class="muted">${escape(r.date_display)}</small>
                    </td>
                    <td class="col-size" data-col="size">
                      <small class="muted">${escape(r.size_display)}</small>
                    </td>
                    <td class="col-type" data-col="type">
                      <small class="muted">${escape(r.type)}</small>
                    </td>
                    <td class="col-parent" data-col="parent">
                      ${r.parent
                        ? html`<small class="muted" title="Attached to email">${escape(r.parent)}</small>`
                        : ''}
                    </td>
                    <td class="col-actions" data-col="actions">
                      <div class="claudia-doc-actions">
                        <button type="button"
                                class="claudia-doc-btn ${r.retention === 'keep_forever' ? 'active' : ''}"
                                title="${r.retention === 'keep_forever' ? 'Unkeep' : 'Keep forever'}"
                                hx-post="/sandbox/assistant/documents/${escape(r.id)}/retention?to=${r.retention === 'keep_forever' ? 'auto' : 'keep_forever'}"
                                hx-swap="none">★</button>
                        <button type="button"
                                class="claudia-doc-btn danger"
                                title="Move to trash"
                                hx-post="/sandbox/assistant/documents/${escape(r.id)}/retention?to=trashed"
                                hx-confirm="Move this document to trash? You can restore it later from the database."
                                hx-target="closest tr"
                                hx-swap="outerHTML">×</button>
                      </div>
                    </td>
                  </tr>`)}
              </tbody>
            </table>
          </div>
          <style>
            /* Mirror the badge palette from the assistant page so the
               Inbox table renders the same color tags. (Inbox is a
               separate route so the assistant page's <style> doesn't
               apply here.) */
            .claudia-doc-badge {
              display: inline-block; font-size: 11px; padding: 2px 8px;
              border-radius: 999px; font-weight: 500; letter-spacing: 0.02em;
            }
            .claudia-doc-badge.cat {
              background: #ecfeff; color: #0369a1; border: 1px solid #bae6fd;
              font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
              text-transform: lowercase;
            }
            .claudia-doc-badge.cat-rfq          { background: #fee2e2; color: #b91c1c; border-color: #fecaca; }
            .claudia-doc-badge.cat-quote        { background: #dcfce7; color: #166534; border-color: #bbf7d0; }
            .claudia-doc-badge.cat-spec         { background: #dbeafe; color: #1e40af; border-color: #bfdbfe; }
            .claudia-doc-badge.cat-po           { background: #ede9fe; color: #5b21b6; border-color: #ddd6fe; }
            .claudia-doc-badge.cat-contract     { background: #ede9fe; color: #5b21b6; border-color: #ddd6fe; }
            .claudia-doc-badge.cat-invoice      { background: #fef3c7; color: #92400e; border-color: #fde68a; }
            .claudia-doc-badge.cat-email        { background: #f1f5f9; color: #475569; border-color: #e2e8f0; }
            .claudia-doc-badge.cat-meeting_note { background: #fdf4ff; color: #86198f; border-color: #f5d0fe; }
            .claudia-doc-badge.cat-contact_list { background: #f0fdfa; color: #0f766e; border-color: #ccfbf1; }
            .claudia-doc-badge.cat-business_card{ background: #f0fdfa; color: #0f766e; border-color: #ccfbf1; }
            .claudia-doc-badge.cat-marketing    { background: #fff7ed; color: #9a3412; border-color: #fed7aa; }
            .claudia-doc-badge.cat-badge        { background: #fff7ed; color: #9a3412; border-color: #fed7aa; }
            .claudia-doc-badge.cat-spreadsheet  { background: #ecfdf5; color: #065f46; border-color: #a7f3d0; }
            .claudia-doc-badge.cat-other        { background: #f1f5f9; color: #475569; border-color: #e2e8f0; }
            .claudia-doc-actions { display: flex; gap: 4px; }
            .claudia-doc-btn {
              background: transparent; border: 1px solid transparent; color: #6b7280;
              cursor: pointer; padding: 2px 8px; border-radius: 4px; font-size: 14px;
              line-height: 1; min-width: 26px;
            }
            .claudia-doc-btn:hover { background: #f1f3f7; color: #1a1a22; border-color: #e2e8f0; }
            .claudia-doc-btn.active { color: #b45309; }
            .claudia-doc-btn.danger:hover { color: #b91c1c; background: #fef2f2; border-color: #fecaca; }
          </style>
          <script>${raw(listScript('pipeline.claudia.inbox.v1', 'date', 'desc'))}</script>`}
    </section>`;

  return htmlResponse(
    layout('Inbox', body, {
      user,
      env: data?.env,
      activeNav: '/sandbox/assistant',
      breadcrumbs: [
        { label: 'Claudia', href: '/sandbox/assistant' },
        { label: 'Inbox' },
      ],
    })
  );
}

function isEmailType(contentType, filename) {
  const ct = String(contentType || '').toLowerCase();
  if (ct === 'message/rfc822' || ct === 'application/mbox') return true;
  return /\.(eml|mbox)$/i.test(String(filename || ''));
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
