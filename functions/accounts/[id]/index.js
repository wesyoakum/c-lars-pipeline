// functions/accounts/[id]/index.js
//
// GET  /accounts/:id  — account detail (overview, contacts, activity feed)
// POST /accounts/:id  — update account (from the edit form)
//
// The detail page has three tabs rendered as stacked cards on one page
// (we'll break them into true tabs when the detail pages get busier).

import { one, all, stmt, batch } from '../../lib/db.js';
import { auditStmt, diff } from '../../lib/audit.js';
import {
  validateAccount,
  parseTransactionTypes,
  QUOTE_TYPE_LABELS,
  QUOTE_STATUS_LABELS,
} from '../../lib/validators.js';
import { layout, htmlResponse, html, raw, escape } from '../../lib/layout.js';
import { now } from '../../lib/ids.js';
import { redirectWithFlash, formBody, readFlash } from '../../lib/http.js';
import {
  loadAddresses,
  renderAddressEditor,
  addressEditorScript,
  parseAddressForm,
  buildAddressStatements,
} from '../../lib/address_editor.js';
import { slugifyGroup, loadSiblingAccounts, listGroupLabels } from '../../lib/account-groups.js';
import { loadStageCatalog } from '../../lib/stages.js';
import { fmtDollar } from '../../lib/pricing.js';

const UPDATE_FIELDS = [
  'name',
  'segment',
  'phone',
  'website',
  'address_billing',
  'address_physical',
  'notes',
  'owner_user_id',
  'is_active',
];

// Active/Inactive options for the inline-edit Status control. The
// patch handler accepts the string forms and coerces them to 0/1.
const ACTIVE_OPTIONS = [
  { value: 'active',   label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];

const SEGMENT_OPTIONS = [
  { value: '', label: '— None —' },
  { value: 'WROV', label: 'WROV' },
  { value: 'Research', label: 'Research' },
  { value: 'Defense', label: 'Defense' },
  { value: 'Commercial', label: 'Commercial' },
  { value: 'Other', label: 'Other' },
];

// Kept in sync with functions/documents/library.js — duplicated here
// rather than exported so this page has no extra coupling across the
// documents feature.
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

function stageLabelFor(catalog, txType, stageKey) {
  const list = catalog.get(txType) ?? [];
  const def = list.find((s) => s.stage_key === stageKey);
  return def?.label ?? stageKey ?? '';
}

function oppTypeDisplay(transactionType) {
  const parts = parseTransactionTypes(transactionType);
  if (!parts.length) return '';
  return parts.map((t) => QUOTE_TYPE_LABELS[t] ?? t).join(' + ');
}

function quoteStatusPillClass(s) {
  switch (s) {
    case 'draft':
    case 'revision_draft':
      return '';
    case 'issued':
    case 'revision_issued':
    case 'accepted':
      return 'pill-success';
    case 'rejected':
    case 'expired':
    case 'dead':
      return 'pill-locked';
    default:
      return '';
  }
}

// ---- helpers for inline-editable fields ----------------------------------

function inlineText(field, value, opts = {}) {
  const display = value || opts.placeholder || '—';
  const displayClass = value ? '' : 'muted';
  return html`<span class="ie" data-field="${field}" data-type="text" ${opts.inputType ? `data-input-type="${opts.inputType}"` : ''}>
    <span class="ie-display ${displayClass}">${escape(display)}</span>
  </span>`;
}

function inlineTextarea(field, value, opts = {}) {
  const display = value || opts.placeholder || '—';
  const displayClass = value ? '' : 'muted';
  return html`<span class="ie" data-field="${field}" data-type="textarea">
    <span class="ie-display ${displayClass}">${escape(display)}</span>
    <span class="ie-raw" hidden>${escape(value ?? '')}</span>
  </span>`;
}

function inlineSelect(field, value, options, opts = {}) {
  const selectedOpt = options.find(o => o.value === (value ?? ''));
  // When the value is empty and a placeholder is provided, render the
  // placeholder in muted text (matches inlineText's behavior) instead
  // of whatever label the empty option had.
  const display = value
    ? (selectedOpt?.label || value)
    : (opts.placeholder || selectedOpt?.label || '—');
  const displayClass = value ? '' : 'muted';
  const optJson = JSON.stringify(options);
  const allowNewAttr = opts.allowNew ? ' data-allow-new="true"' : '';
  return html`<span class="ie" data-field="${field}" data-type="select" data-options='${escape(optJson)}'${raw(allowNewAttr)}>
    <span class="ie-display ${displayClass}">${escape(display)}</span>
  </span>`;
}

export async function onRequestGet(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const accountId = params.id;

  const account = await one(
    env.DB,
    `SELECT a.*, u.display_name AS owner_name, u.email AS owner_email
       FROM accounts a
       LEFT JOIN users u ON u.id = a.owner_user_id
      WHERE a.id = ?`,
    [accountId]
  );
  if (!account) return notFound(context);

  const contacts = await all(
    env.DB,
    `SELECT id, first_name, last_name, title, email, phone, mobile, is_primary
       FROM contacts
      WHERE account_id = ?
      ORDER BY is_primary DESC, last_name, first_name`,
    [accountId]
  );

  const addresses = await loadAddresses(env.DB, accountId);

  // Siblings in the same parent_group, if any. Used both for the
  // sidebar strip on this page and (indirectly) to tell the group
  // rollup link whether there is actually anything to show.
  const siblings = await loadSiblingAccounts(env.DB, accountId, account.parent_group);
  const groupSlug = slugifyGroup(account.parent_group);

  // Build the parent-group dropdown from the distinct set of labels
  // already in use, plus a sentinel "+ Add new group…" option. The
  // client-side activate() intercepts the __new__ value and swaps the
  // <select> for a text input so the user can type a fresh label.
  const existingGroupLabels = await listGroupLabels(env);
  const groupOptions = [
    { value: '', label: '— None —' },
    ...existingGroupLabels.map((g) => ({ value: g, label: g })),
    { value: '__new__', label: '+ Add new group\u2026' },
  ];

  const users = await all(
    env.DB,
    `SELECT id, display_name, email FROM users WHERE active = 1 ORDER BY display_name`
  );

  const ownerOptions = [
    { value: '', label: '— None —' },
    ...users.map(u => ({ value: u.id, label: u.display_name ?? u.email })),
  ];

  // Related-records sections: opportunities, quotes, and documents for
  // this account. Quotes reach the account via the opportunities join;
  // documents can be attached directly to the account, to an opp, or
  // to a quote on one of its opps. Note-attachment documents (those
  // with `activity_id` set) are excluded — they render inline with
  // their note. All four queries run in parallel so the page does not
  // serialize on database latency.
  const [accountOpps, accountQuotes, accountDocs, stageCatalog] = await Promise.all([
    all(
      env.DB,
      `SELECT id, number, title, transaction_type, stage,
              estimated_value_usd, owner_user_id, updated_at, created_at
         FROM opportunities
        WHERE account_id = ?
        ORDER BY updated_at DESC
        LIMIT 100`,
      [accountId]
    ),
    all(
      env.DB,
      `SELECT q.id, q.number, q.revision, q.quote_type, q.status,
              q.title, q.total_price, q.valid_until, q.updated_at,
              q.opportunity_id,
              o.number AS opp_number, o.title AS opp_title
         FROM quotes q
         JOIN opportunities o ON o.id = q.opportunity_id
        WHERE o.account_id = ?
        ORDER BY q.updated_at DESC
        LIMIT 100`,
      [accountId]
    ),
    all(
      env.DB,
      `SELECT d.id, d.kind, d.title, d.original_filename, d.mime_type,
              d.size_bytes, d.uploaded_at,
              d.account_id, d.opportunity_id, d.quote_id,
              o.number AS opp_number,
              q.number AS quote_number, q.revision AS quote_revision
         FROM documents d
         LEFT JOIN opportunities o ON o.id = d.opportunity_id
         LEFT JOIN quotes q        ON q.id = d.quote_id
        WHERE (d.account_id = ?
            OR d.opportunity_id IN (SELECT id FROM opportunities WHERE account_id = ?)
            OR d.quote_id IN (SELECT q2.id FROM quotes q2
                               JOIN opportunities o2 ON o2.id = q2.opportunity_id
                              WHERE o2.account_id = ?))
          AND d.activity_id IS NULL
        ORDER BY d.uploaded_at DESC
        LIMIT 100`,
      [accountId, accountId, accountId]
    ),
    loadStageCatalog(env.DB),
  ]);

  // Pre-format rows so the template stays simple.
  const userDisplayById = new Map(users.map((u) => [u.id, u.display_name ?? u.email]));
  const oppRows = accountOpps.map((o) => {
    const firstType = parseTransactionTypes(o.transaction_type)[0] ?? 'spares';
    return {
      id: o.id,
      number: o.number ?? '',
      title: o.title ?? '',
      typeLabel: oppTypeDisplay(o.transaction_type),
      stageLabel: stageLabelFor(stageCatalog, firstType, o.stage),
      value: o.estimated_value_usd,
      owner: userDisplayById.get(o.owner_user_id) ?? '',
      updated: (o.updated_at ?? '').slice(0, 10),
    };
  });
  const quoteRows = accountQuotes.map((q) => ({
    id: q.id,
    opportunity_id: q.opportunity_id,
    number: q.number ?? '',
    revision: q.revision ?? '',
    typeLabel: QUOTE_TYPE_LABELS[q.quote_type] ?? q.quote_type ?? '',
    status: q.status ?? '',
    statusLabel: QUOTE_STATUS_LABELS[q.status] ?? q.status ?? '',
    title: q.title ?? '',
    oppNumber: q.opp_number ?? '',
    oppTitle: q.opp_title ?? '',
    total: q.total_price,
    validUntil: q.valid_until ?? '',
    updated: (q.updated_at ?? '').slice(0, 10),
  }));
  const docRows = accountDocs.map((d) => {
    // Render a short "Linked to" hint so the user can tell if a doc
    // is attached to the account itself, to an opportunity, or to a
    // specific quote.
    let linkedTo = '';
    let linkedHref = '';
    if (d.quote_number) {
      linkedTo = `Quote ${d.quote_number}${d.quote_revision && d.quote_revision !== 'v1' ? ` ${d.quote_revision}` : ''}`;
      linkedHref = d.opportunity_id && d.quote_id
        ? `/opportunities/${d.opportunity_id}/quotes/${d.quote_id}`
        : '';
    } else if (d.opp_number) {
      linkedTo = `Opp ${d.opp_number}`;
      linkedHref = d.opportunity_id ? `/opportunities/${d.opportunity_id}` : '';
    } else if (d.account_id) {
      linkedTo = 'Account';
      linkedHref = '';
    }
    return {
      id: d.id,
      kind: d.kind ?? '',
      kindLabel: DOC_KIND_LABELS[d.kind] ?? d.kind ?? '',
      title: d.title || d.original_filename || '(untitled)',
      filename: d.original_filename ?? '',
      size: formatSize(d.size_bytes),
      uploaded: (d.uploaded_at ?? '').slice(0, 10),
      linkedTo,
      linkedHref,
    };
  });

  const events = await all(
    env.DB,
    `SELECT ae.event_type, ae.at, ae.summary, ae.changes_json,
            ae.entity_type, ae.entity_id, u.email AS user_email, u.display_name AS user_name
       FROM audit_events ae
       LEFT JOIN users u ON u.id = ae.user_id
      WHERE (ae.entity_type = 'account' AND ae.entity_id = ?)
         OR (ae.entity_type = 'contact' AND ae.entity_id IN
             (SELECT id FROM contacts WHERE account_id = ?))
      ORDER BY ae.at DESC
      LIMIT 100`,
    [accountId, accountId]
  );

  const body = html`
    <section class="card" x-data="acctInline('${escape(account.id)}')">
      <div class="card-header">
        <div>
          <h1>${inlineText('name', account.name)}</h1>
          ${account.parent_group
            ? html`<div class="muted" style="margin-top:0.15rem;font-size:0.9em">
                Part of
                <a href="/accounts/group/${escape(groupSlug)}"><strong>${escape(account.parent_group)}</strong></a>
              </div>`
            : ''}
        </div>
        <div class="header-actions">
          <form method="post" action="/accounts/${escape(account.id)}/delete"
                onsubmit="return confirm('Delete ${escape(account.name)} and all its contacts? This cannot be undone.');"
                style="display:inline">
            <button type="submit" class="btn danger">Delete</button>
          </form>
        </div>
      </div>

      <div class="detail-grid">
        <div class="detail-pair">
          <span class="detail-label">Alias</span>
          <span class="detail-value">${inlineText('alias', account.alias, { placeholder: 'Click to set a short nickname\u2026' })}</span>
        </div>
        <div class="detail-pair">
          <span class="detail-label">Parent group</span>
          <span class="detail-value">${inlineSelect('parent_group', account.parent_group, groupOptions, { allowNew: true, placeholder: 'Click to assign a group\u2026' })}</span>
        </div>
        <div class="detail-pair">
          <span class="detail-label">Segment</span>
          <span class="detail-value">${inlineSelect('segment', account.segment, SEGMENT_OPTIONS)}</span>
        </div>
        <div class="detail-pair">
          <span class="detail-label">Status</span>
          <span class="detail-value">${inlineSelect('is_active', account.is_active === 0 ? 'inactive' : 'active', ACTIVE_OPTIONS)}</span>
        </div>
        <div class="detail-pair">
          <span class="detail-label">Phone</span>
          <span class="detail-value">${inlineText('phone', account.phone)}</span>
        </div>
        <div class="detail-pair">
          <span class="detail-label">Website</span>
          <span class="detail-value">${inlineText('website', account.website)}</span>
        </div>
        <div class="detail-pair">
          <span class="detail-label">Owner</span>
          <span class="detail-value">${inlineSelect('owner_user_id', account.owner_user_id, ownerOptions)}</span>
        </div>
      </div>

      <form method="post" action="/accounts/${escape(account.id)}/addresses" class="inline-address-form">
        ${renderAddressEditor(addresses)}
        <div class="form-actions" style="margin-top:0.5rem">
          <button type="submit" class="btn primary">Save addresses</button>
        </div>
      </form>

      <h3 style="margin-top:1rem">Notes</h3>
      ${inlineTextarea('notes', account.notes, { placeholder: 'Click to add notes…' })}
    </section>

    ${siblings.length > 0
      ? html`<section class="card">
          <div class="card-header">
            <h2>Also in <a href="/accounts/group/${escape(groupSlug)}">${escape(account.parent_group)}</a></h2>
            <a class="btn" href="/accounts/group/${escape(groupSlug)}">Open group rollup</a>
          </div>
          <ul class="chips" style="display:flex;flex-wrap:wrap;gap:0.4rem;padding:0 1rem 1rem;list-style:none;margin:0">
            ${siblings.map((s) => html`
              <li><a class="pill" href="/accounts/${escape(s.id)}">
                ${escape(s.name)}${s.alias ? html` <span class="muted">(${escape(s.alias)})</span>` : ''}
              </a></li>
            `)}
          </ul>
        </section>`
      : ''}

    <section class="card">
      <div class="card-header">
        <h2>Opportunities (${oppRows.length})</h2>
        <a class="btn primary" href="/opportunities/new?account=${escape(account.id)}">New opportunity</a>
      </div>
      ${oppRows.length === 0
        ? html`<p class="muted">No opportunities yet.</p>`
        : html`
          <table class="data compact">
            <thead>
              <tr>
                <th>Number</th>
                <th>Title</th>
                <th>Type</th>
                <th>Stage</th>
                <th class="num">Value</th>
                <th>Owner</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              ${oppRows.map((o) => html`
                <tr>
                  <td><a href="/opportunities/${escape(o.id)}"><code>${escape(o.number)}</code></a></td>
                  <td><a href="/opportunities/${escape(o.id)}">${escape(o.title || '(untitled)')}</a></td>
                  <td>${escape(o.typeLabel)}</td>
                  <td><span class="pill">${escape(o.stageLabel)}</span></td>
                  <td class="num">${escape(o.value != null ? fmtDollar(o.value) : '\u2014')}</td>
                  <td>${escape(o.owner)}</td>
                  <td><small class="muted">${escape(o.updated)}</small></td>
                </tr>
              `)}
            </tbody>
          </table>
        `}
    </section>

    <section class="card">
      <div class="card-header">
        <h2>Quotes (${quoteRows.length})</h2>
      </div>
      ${quoteRows.length === 0
        ? html`<p class="muted">No quotes yet.</p>`
        : html`
          <table class="data compact">
            <thead>
              <tr>
                <th>Number</th>
                <th>Rev</th>
                <th>Type</th>
                <th>Title</th>
                <th>Opportunity</th>
                <th>Status</th>
                <th class="num">Total</th>
                <th>Valid until</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              ${quoteRows.map((q) => html`
                <tr>
                  <td><a href="/opportunities/${escape(q.opportunity_id)}/quotes/${escape(q.id)}"><code>${escape(q.number)}</code></a></td>
                  <td>${escape(q.revision)}</td>
                  <td>${escape(q.typeLabel)}</td>
                  <td>${escape(q.title || '(no title)')}</td>
                  <td><a href="/opportunities/${escape(q.opportunity_id)}"><code>${escape(q.oppNumber)}</code> ${escape(q.oppTitle)}</a></td>
                  <td><span class="pill ${quoteStatusPillClass(q.status)}">${escape(q.statusLabel)}</span></td>
                  <td class="num">${escape(q.total != null ? fmtDollar(q.total) : '\u2014')}</td>
                  <td><small class="muted">${escape(q.validUntil)}</small></td>
                  <td><small class="muted">${escape(q.updated)}</small></td>
                </tr>
              `)}
            </tbody>
          </table>
        `}
    </section>

    <section class="card">
      <div class="card-header">
        <h2>Documents (${docRows.length})</h2>
        <a class="btn" href="/documents/library">Open library</a>
      </div>
      ${docRows.length === 0
        ? html`<p class="muted">No documents yet.</p>`
        : html`
          <table class="data compact">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Title</th>
                <th>Linked to</th>
                <th class="num">Size</th>
                <th>Uploaded</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${docRows.map((d) => html`
                <tr>
                  <td><span class="pill">${escape(d.kindLabel)}</span></td>
                  <td><a href="/documents/${escape(d.id)}/download">${escape(d.title)}</a></td>
                  <td>${d.linkedHref
                    ? html`<a href="${escape(d.linkedHref)}">${escape(d.linkedTo)}</a>`
                    : html`<small class="muted">${escape(d.linkedTo)}</small>`}</td>
                  <td class="num"><small class="muted">${escape(d.size)}</small></td>
                  <td><small class="muted">${escape(d.uploaded)}</small></td>
                  <td class="row-actions"><a class="btn btn-sm" href="/documents/${escape(d.id)}/download">Download</a></td>
                </tr>
              `)}
            </tbody>
          </table>
        `}
    </section>

    <section class="card">
      <div class="card-header">
        <h2>Contacts (${contacts.length})</h2>
        <a class="btn primary" href="/accounts/${escape(account.id)}/contacts/new">New contact</a>
      </div>

      ${contacts.length === 0
        ? html`<p class="muted">No contacts yet.</p>`
        : html`
          <table class="data">
            <thead>
              <tr>
                <th>First</th>
                <th>Last</th>
                <th>Title</th>
                <th>Email</th>
                <th>Phone</th>
                <th>Primary</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${contacts.map(c => {
                const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || '(no name)';
                return html`<tr x-data="contactInline('${escape(c.id)}')">
                  <td><span class="ie" data-field="first_name" data-type="text" @click="activate($el)"><span class="ie-display">${escape(c.first_name ?? '')}</span></span></td>
                  <td><span class="ie" data-field="last_name" data-type="text" @click="activate($el)"><span class="ie-display"><strong>${escape(c.last_name ?? '')}</strong></span></span></td>
                  <td><span class="ie" data-field="title" data-type="text" @click="activate($el)"><span class="ie-display">${escape(c.title ?? '')}</span></span></td>
                  <td><span class="ie" data-field="email" data-type="text" @click="activate($el)"><span class="ie-display">${c.email ? html`<a href="mailto:${escape(c.email)}" @click.stop>${escape(c.email)}</a>` : html`<span class="muted">—</span>`}</span></span></td>
                  <td><span class="ie" data-field="phone" data-type="text" @click="activate($el)"><span class="ie-display">${escape(c.phone ?? '')}</span></span></td>
                  <td>${c.is_primary ? html`<span class="pill pill-success">primary</span>` : ''}</td>
                  <td class="row-actions">
                    <form method="post" action="/contacts/${escape(c.id)}/delete"
                          onsubmit="return confirm('Delete contact ${escape(name)}?');"
                          style="display:inline">
                      <button type="submit" class="btn btn-sm danger">Delete</button>
                    </form>
                  </td>
                </tr>`; })}
            </tbody>
          </table>
        `}
    </section>

    <section class="card">
      <h2>Activity</h2>
      ${events.length === 0
        ? html`<p class="muted">No activity yet.</p>`
        : html`
          <ul class="activity">
            ${raw(
              events
                .map((e) => {
                  const who = escape(e.user_name ?? e.user_email ?? 'system');
                  const when = escape(formatTimestamp(e.at));
                  const scope = e.entity_type === 'contact' ? ' <small class="muted">(contact)</small>' : '';
                  const summary = escape(e.summary ?? `${e.event_type} ${e.entity_type}`);
                  const changes = renderChanges(e.changes_json);
                  return `<li>
                    <div class="activity-head">
                      <strong>${who}</strong>
                      <span class="activity-type">${escape(e.event_type)}</span>${scope}
                      <span class="activity-when muted">${when}</span>
                    </div>
                    <div>${summary}</div>
                    ${changes}
                  </li>`;
                })
                .join('')
            )}
          </ul>
        `}
    </section>

    <script>
    function acctInline(acctId) {
      const patchUrl = '/accounts/' + acctId + '/patch';
      return {
        init() {
          this.$el.querySelectorAll('.ie').forEach(el => {
            el.addEventListener('click', () => this.activate(el));
          });
        },
        activate(el) {
          if (el.querySelector('.ie-input')) return;
          const field = el.dataset.field;
          const type = el.dataset.type;
          const display = el.querySelector('.ie-display');
          const rawEl = el.querySelector('.ie-raw');
          const currentValue = rawEl ? rawEl.textContent : (display.classList.contains('muted') ? '' : display.textContent.trim());

          let input;
          if (type === 'select') {
            input = document.createElement('select');
            input.className = 'ie-input';
            const options = JSON.parse(el.dataset.options || '[]');
            options.forEach(o => {
              const opt = document.createElement('option');
              opt.value = o.value;
              opt.textContent = o.label;
              if (o.value === (currentValue || '')) opt.selected = true;
              input.appendChild(opt);
            });
            const self = this;
            input.addEventListener('change', () => {
              // Allow-new selects use the __new__ sentinel to mean
              // "the user wants to type a fresh label". Swap the
              // <select> out for a text <input> and let them type.
              if (el.dataset.allowNew === 'true' && input.value === '__new__') {
                el.removeChild(input);
                const txt = document.createElement('input');
                txt.type = 'text';
                txt.className = 'ie-input';
                txt.placeholder = 'Type a new label\u2026';
                txt.addEventListener('blur', () => self.save(el, txt));
                txt.addEventListener('keydown', (e) => {
                  if (e.key === 'Enter') { e.preventDefault(); self.save(el, txt); }
                  if (e.key === 'Escape') { self.deactivate(el, txt); }
                });
                el.appendChild(txt);
                txt.focus();
              } else {
                self.save(el, input);
              }
            });
            input.addEventListener('blur', () => {
              setTimeout(() => this.deactivate(el, input), 150);
            });
          } else if (type === 'textarea') {
            input = document.createElement('textarea');
            input.className = 'ie-input';
            input.rows = 3;
            input.value = currentValue;
            input.addEventListener('blur', () => this.save(el, input));
            input.addEventListener('keydown', (e) => {
              if (e.key === 'Escape') { this.deactivate(el, input); }
            });
          } else {
            input = document.createElement('input');
            input.type = el.dataset.inputType || 'text';
            input.className = 'ie-input';
            input.value = currentValue;
            input.addEventListener('blur', () => this.save(el, input));
            input.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') { e.preventDefault(); this.save(el, input); }
              if (e.key === 'Escape') { this.deactivate(el, input); }
            });
          }

          display.style.display = 'none';
          el.appendChild(input);
          input.focus();
          if (input.select) input.select();
        },
        async save(el, input) {
          const field = el.dataset.field;
          const value = input.value;
          this.deactivate(el, input);

          el.classList.add('ie-saving');
          try {
            const res = await fetch(patchUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ field, value }),
            });
            const data = await res.json();
            if (!data.ok) {
              el.classList.add('ie-error');
              setTimeout(() => el.classList.remove('ie-error'), 2000);
              return;
            }
            const display = el.querySelector('.ie-display');
            const rawEl = el.querySelector('.ie-raw');
            if (el.dataset.type === 'select') {
              const options = JSON.parse(el.dataset.options || '[]');
              const opt = options.find(o => o.value === (data.value || ''));
              display.textContent = opt ? opt.label : (data.value || '\u2014');
              // If this is an allow-new select and the user just typed
              // a label that wasn't in the dropdown, persist it into
              // the options dataset so the next click shows it in the
              // list. Keeps the __new__ sentinel at the bottom.
              if (el.dataset.allowNew === 'true' && data.value && !opt) {
                const newOpt = { value: data.value, label: data.value };
                const newIdx = options.findIndex(o => o.value === '__new__');
                if (newIdx >= 0) options.splice(newIdx, 0, newOpt);
                else options.push(newOpt);
                el.dataset.options = JSON.stringify(options);
              }
            } else {
              display.textContent = data.value || '\u2014';
            }
            display.classList.toggle('muted', !data.value);
            if (rawEl) rawEl.textContent = data.value ?? '';

            // Update page title if name changed
            if (field === 'name' && data.value) {
              document.title = data.value + ' \u2014 PMS';
              const crumb = document.querySelector('.breadcrumbs span:last-child, .breadcrumbs a:last-child');
            }

            el.classList.add('ie-saved');
            setTimeout(() => el.classList.remove('ie-saved'), 1200);
          } catch (err) {
            el.classList.add('ie-error');
            setTimeout(() => el.classList.remove('ie-error'), 2000);
          } finally {
            el.classList.remove('ie-saving');
          }
        },
        deactivate(el, input) {
          if (input && input.parentNode === el) el.removeChild(input);
          const display = el.querySelector('.ie-display');
          if (display) display.style.display = '';
        },
      };
    }

    ${raw(addressEditorScript())}

    function contactInline(contactId) {
      const patchUrl = '/contacts/' + contactId + '/patch';
      return {
        activate(el) {
          if (el.querySelector('.ie-input')) return;
          const field = el.dataset.field;
          const display = el.querySelector('.ie-display');
          const currentValue = display.textContent.trim() === '—' ? '' : display.textContent.trim();
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'ie-input';
          input.value = currentValue;
          input.addEventListener('blur', () => this.save(el, input));
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); this.save(el, input); }
            if (e.key === 'Escape') { this.deactivate(el, input); }
          });
          display.style.display = 'none';
          el.appendChild(input);
          input.focus();
          input.select();
        },
        async save(el, input) {
          const field = el.dataset.field;
          const value = input.value;
          this.deactivate(el, input);
          el.classList.add('ie-saving');
          try {
            const res = await fetch(patchUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ field, value }),
            });
            const data = await res.json();
            if (!data.ok) {
              el.classList.add('ie-error');
              setTimeout(() => el.classList.remove('ie-error'), 2000);
              return;
            }
            const display = el.querySelector('.ie-display');
            if (field === 'email' && data.value) {
              display.innerHTML = '<a href="mailto:' + data.value + '">' + data.value + '</a>';
            } else {
              display.textContent = data.value || '—';
              display.classList.toggle('muted', !data.value);
            }
            el.classList.add('ie-saved');
            setTimeout(() => el.classList.remove('ie-saved'), 1200);
          } catch (err) {
            el.classList.add('ie-error');
            setTimeout(() => el.classList.remove('ie-error'), 2000);
          } finally {
            el.classList.remove('ie-saving');
          }
        },
        deactivate(el, input) {
          if (input && input.parentNode === el) el.removeChild(input);
          const display = el.querySelector('.ie-display');
          if (display) display.style.display = '';
        },
      };
    }
    </script>
  `;

  return htmlResponse(
    layout(account.name, body, {
      user,
      env: data?.env,
      activeNav: '/accounts',
      flash: readFlash(url),
      breadcrumbs: [
        { label: 'Accounts', href: '/accounts' },
        { label: escape(account.name) },
      ],
    })
  );
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const accountId = params.id;

  const before = await one(
    env.DB,
    `SELECT * FROM accounts WHERE id = ?`,
    [accountId]
  );
  if (!before) return notFound(context);

  const input = await formBody(request);
  const { ok, value, errors } = validateAccount(input);
  const submittedAddresses = parseAddressForm(input);

  if (!ok) {
    // Re-render the edit form with errors, preserving the user's in-flight
    // address edits.
    const { renderEditForm } = await import('./edit.js');
    return renderEditForm(context, {
      account: { ...before, ...input },
      errors,
      addresses: submittedAddresses,
    });
  }

  const existingAddresses = await loadAddresses(env.DB, accountId);

  // Keep the denormalized convenience columns on accounts in sync with the
  // submitted list (first default-or-first wins per kind).
  const firstBilling =
    submittedAddresses.find((a) => a.kind === 'billing' && a.is_default) ||
    submittedAddresses.find((a) => a.kind === 'billing');
  const firstPhysical =
    submittedAddresses.find((a) => a.kind === 'physical' && a.is_default) ||
    submittedAddresses.find((a) => a.kind === 'physical');

  const ts = now();
  const after = {
    ...value,
    address_billing: firstBilling?.address ?? null,
    address_physical: firstPhysical?.address ?? null,
  };
  const changes = diff(before, after, UPDATE_FIELDS);

  const { statements: addrStmts, changes: addrChanges } = buildAddressStatements(
    env.DB,
    accountId,
    submittedAddresses,
    existingAddresses,
    user
  );

  const statements = [
    stmt(
      env.DB,
      `UPDATE accounts
          SET name = ?, segment = ?, phone = ?, website = ?,
              address_billing = ?, address_physical = ?, notes = ?,
              owner_user_id = ?, updated_at = ?
        WHERE id = ?`,
      [
        value.name,
        value.segment,
        value.phone,
        value.website,
        after.address_billing,
        after.address_physical,
        value.notes,
        value.owner_user_id,
        ts,
        accountId,
      ]
    ),
    ...addrStmts,
  ];

  // Only write an audit event if something actually changed, so that a
  // plain re-save doesn't pollute the timeline.
  const addressesDirty =
    addrChanges.inserted > 0 || addrChanges.updated > 0 || addrChanges.deleted > 0;
  if (changes || addressesDirty) {
    statements.push(
      auditStmt(env.DB, {
        entityType: 'account',
        entityId: accountId,
        eventType: 'updated',
        user,
        summary: `Updated account "${value.name}"`,
        changes: {
          ...(changes || {}),
          ...(addressesDirty ? { addresses: addrChanges } : {}),
        },
      })
    );
  }

  await batch(env.DB, statements);

  return redirectWithFlash(`/accounts/${accountId}`, `Saved.`);
}

// -- helpers ---------------------------------------------------------------

function ensureHttp(url) {
  if (!url) return '';
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function formatTimestamp(iso) {
  if (!iso) return '';
  // Show "2026-04-10 17:42" — short and unambiguous.
  return iso.replace('T', ' ').replace(/\.\d+Z?$/, '').slice(0, 16);
}

function renderChanges(json) {
  if (!json) return '';
  let obj;
  try {
    obj = JSON.parse(json);
  } catch {
    return '';
  }
  if (!obj || typeof obj !== 'object') return '';
  const keys = Object.keys(obj);
  if (keys.length === 0) return '';
  // If the object is a "diff" shape ({ field: { from, to } }), render
  // just the field names. Otherwise, render as "created with" details.
  const isDiff = keys.every(
    (k) => obj[k] && typeof obj[k] === 'object' && 'from' in obj[k] && 'to' in obj[k]
  );
  if (isDiff) {
    return `<div class="activity-changes"><small class="muted">Changed: ${keys.map((k) => `<code>${escape(k)}</code>`).join(', ')}</small></div>`;
  }
  return '';
}

function notFound(context) {
  const { data } = context;
  return htmlResponse(
    layout(
      'Account not found',
      `<section class="card">
        <h1>Account not found</h1>
        <p><a href="/accounts">Back to accounts</a></p>
      </section>`,
      { user: data?.user, env: data?.env, activeNav: '/accounts' }
    ),
    { status: 404 }
  );
}
