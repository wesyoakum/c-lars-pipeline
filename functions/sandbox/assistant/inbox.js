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
    // First column is a row checkbox for bulk selection. Sort/filter
    // are off (it's a control, not data); default true so the
    // hamburger column-menu doesn't accidentally hide it.
    { key: 'select',   label: '',               sort: null,     filter: null,     default: true },
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
      date_display: formatLocalDateTime(dateIso),
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

      <div class="bulk-action-bar" data-role="bulk-action-bar">
        <span class="bulk-count"><strong data-role="bulk-action-count">0</strong> selected</span>
        <button type="button" class="btn btn-sm danger" data-role="bulk-trash">Trash selected</button>
        <button type="button" class="btn btn-sm" data-role="bulk-clear">Clear</button>
      </div>

      ${rows.length === 0
        ? html`<p class="muted">No documents yet. Drop files on <a href="/sandbox/assistant">Claudia's chat</a> to start.</p>`
        : html`
          <div class="opp-list" data-columns="${escape(JSON.stringify(columns))}">
            <table class="data opp-list-table">
              <thead>
                <tr data-role="header-row">
                  <th class="col-select" data-col="select">
                    <input type="checkbox" data-role="row-select-all" title="Select all visible" aria-label="Select all visible">
                  </th>
                  ${columns.slice(1).map(c => html`
                    <th class="col-${c.key}" data-col="${c.key}">
                      <button type="button" class="col-sort" data-sort="${c.key}" data-sort-type="${c.sort}">
                        <span>${c.label}</span>
                        <span class="sort-indicator" data-role="sort-indicator"></span>
                      </button>
                    </th>`)}
                </tr>
              </thead>
              <tbody data-role="rows">
                ${rowData.map(r => html`
                  <tr data-row-id="${escape(r.id)}"
                      ${raw(rowDataAttrs(columns, r))}>
                    <td class="col-select" data-col="select">
                      <input type="checkbox" class="row-select" data-id="${escape(r.id)}" aria-label="Select row">
                    </td>
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
            /* Bulk action bar — hidden until at least one row is
               selected. Sticks just under the toolbar so it doesn't
               jump the layout when it appears. */
            .bulk-action-bar {
              display: none; align-items: center; gap: 0.6rem;
              background: #fef9c3; border: 1px solid #fde68a;
              padding: 0.4rem 0.7rem; border-radius: 6px;
              margin: 0 0 0.6rem 0; font-size: 13px;
              position: sticky;
              top: calc(var(--site-header-h, 53px) + 8px);
              z-index: 5;
            }
            .bulk-action-bar.show { display: flex; }
            .bulk-action-bar .bulk-count { color: #713f12; }
            .bulk-action-bar .btn { font-size: 12px; padding: 4px 10px; }
            .col-select { width: 32px; text-align: center; }
            .col-select .row-select,
            .col-select [data-role="row-select-all"] {
              cursor: pointer; vertical-align: middle;
            }
            tr.row-selected { background: #fefce8; }
          </style>
          <!-- Storage key bumped to v2 because v1 was set before the
               "select" column existed; returning users with v1 state
               had the select column appended at the END of the table
               (listScript appends unknown new columns) and missed the
               bulk-delete checkboxes entirely. Bumping the key invalidates
               that stale order/visibility map. -->
          <script>${raw(listScript('pipeline.claudia.inbox.v2', 'date', 'desc'))}</script>
          <script>${raw(bulkSelectScript())}</script>`}
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

// Inline client-side script: wires up the row checkboxes, header
// "select all", and the bulk-trash action bar. Returned as a plain
// string (injected via raw()).
function bulkSelectScript() {
  return `
(function() {
  var tbody = document.querySelector('tbody[data-role="rows"]');
  if (!tbody) return;
  var bar       = document.querySelector('[data-role="bulk-action-bar"]');
  var countEl   = document.querySelector('[data-role="bulk-action-count"]');
  var selectAll = document.querySelector('[data-role="row-select-all"]');
  var trashBtn  = document.querySelector('[data-role="bulk-trash"]');
  var clearBtn  = document.querySelector('[data-role="bulk-clear"]');

  function visibleCheckboxes() {
    return Array.prototype.filter.call(
      tbody.querySelectorAll('input.row-select'),
      function(cb) {
        var tr = cb.closest('tr');
        // Honor the list-table client filter / quicksearch — they
        // toggle row display via inline style "display: none".
        return tr && tr.style.display !== 'none';
      }
    );
  }
  function selectedCheckboxes() {
    return visibleCheckboxes().filter(function(cb) { return cb.checked; });
  }

  function updateUI() {
    var sel = selectedCheckboxes();
    var n = sel.length;
    if (countEl) countEl.textContent = String(n);
    if (bar) bar.classList.toggle('show', n > 0);
    // Mark selected rows for visual feedback
    Array.prototype.forEach.call(tbody.querySelectorAll('tr'), function(tr) {
      var cb = tr.querySelector('input.row-select');
      tr.classList.toggle('row-selected', !!(cb && cb.checked));
    });
    // Sync select-all (indeterminate when partial)
    if (selectAll) {
      var visible = visibleCheckboxes();
      selectAll.checked = visible.length > 0 && sel.length === visible.length;
      selectAll.indeterminate = sel.length > 0 && sel.length < visible.length;
    }
  }

  tbody.addEventListener('change', function(e) {
    if (e.target && e.target.classList && e.target.classList.contains('row-select')) {
      updateUI();
    }
  });

  if (selectAll) {
    selectAll.addEventListener('change', function() {
      var checked = selectAll.checked;
      visibleCheckboxes().forEach(function(cb) { cb.checked = checked; });
      updateUI();
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', function() {
      Array.prototype.forEach.call(
        tbody.querySelectorAll('input.row-select:checked'),
        function(cb) { cb.checked = false; }
      );
      updateUI();
    });
  }

  if (trashBtn) {
    trashBtn.addEventListener('click', async function() {
      var sel = selectedCheckboxes();
      var ids = sel.map(function(cb) { return cb.dataset.id; });
      if (!ids.length) return;
      var msg = 'Move ' + ids.length + ' document' + (ids.length === 1 ? '' : 's')
              + ' to trash? You can restore them from the database.';
      if (!confirm(msg)) return;
      trashBtn.disabled = true;
      try {
        var fd = new FormData();
        ids.forEach(function(id) { fd.append('ids', id); });
        var r = await fetch('/sandbox/assistant/documents/bulk-trash', { method: 'POST', body: fd });
        var json = await r.json().catch(function() { return null; });
        if (json && json.ok) {
          // Drop the rows in place — no full reload. Update the list-
          // table count too so the toolbar's "Showing N of M" stays right.
          ids.forEach(function(id) {
            var row = tbody.querySelector('tr[data-row-id="' + id + '"]');
            if (row) row.remove();
          });
          var countDisplay = document.querySelector('[data-role="count"]');
          if (countDisplay) {
            var remaining = tbody.querySelectorAll('tr[data-row-id]').length;
            countDisplay.textContent = remaining;
          }
          updateUI();
        } else {
          alert('Could not trash: ' + ((json && json.error) || 'unknown error'));
        }
      } catch (err) {
        alert('Error: ' + (err && err.message ? err.message : err));
      } finally {
        trashBtn.disabled = false;
      }
    });
  }

  // Quicksearch / column-filter changes hide rows; recompute the
  // select-all state when that happens. The list-table script doesn't
  // emit a custom event, so we observe display changes via a periodic
  // tick triggered by user interaction (input/keyup on the search box,
  // change on filter popovers).
  var quick = document.querySelector('[data-role="quicksearch"]');
  if (quick) quick.addEventListener('input', function() { setTimeout(updateUI, 50); });
  document.addEventListener('change', function(e) {
    if (e.target && e.target.matches && e.target.matches('[data-filter-popover] *')) {
      setTimeout(updateUI, 50);
    }
  });

  updateUI();
})();`;
}

// Render an ISO timestamp as "YYYY-MM-DD HH:MM" in America/Chicago.
// Same TZ that auto-tasks.js (and the rest of the project) treats as
// authoritative — Wes is the only user.
const DATE_TIME_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit',
  hour12: false,
});
function formatLocalDateTime(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  // en-CA gives "YYYY-MM-DD, HH:MM" — strip the comma for a tighter
  // look, since the column is already narrow.
  return DATE_TIME_FMT.format(new Date(ms)).replace(',', '');
}
