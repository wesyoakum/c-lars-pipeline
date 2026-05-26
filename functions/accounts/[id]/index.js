// functions/accounts/[id]/index.js
//
// GET  /accounts/:id           — account detail, overview tab
// GET  /accounts/:id?tab=…     — switch tabs (contacts/opportunities/quotes/tasks/docs/history)
// POST /accounts/:id           — update account (from the legacy edit form)
//
// The detail page mirrors the opportunity detail page — a tab nav card
// followed by a single tab body. Tabs are server-rendered (each link is
// a real GET with `?tab=` so URLs can be shared/bookmarked).

import { one, all, stmt, batch } from '../../lib/db.js';
import { auditStmt, diff, auditViewDeduped } from '../../lib/audit.js';
import {
  validateAccount,
  parseTransactionTypes,
  QUOTE_TYPE_LABELS,
  QUOTE_STATUS_LABELS,
} from '../../lib/validators.js';
import { layout, htmlResponse, html, raw, escape } from '../../lib/layout.js';
import { ICON_MIC } from '../../lib/icons.js';
import { renderMarkdown } from '../../lib/claudia-markdown.js';
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
import { apiGetAll } from '../../lib/katana-client.js';
import { loadStageCatalog } from '../../lib/stages.js';
import { fmtDollar } from '../../lib/pricing.js';
import { INACTIVE_OPPORTUNITY_STAGES } from '../../lib/activeness.js';
import { iconAddButton, listScript, listTableHead, listToolbar, rowDataAttrs } from '../../lib/list-table.js';
import { ieText, ieSelect, listInlineEditScript } from '../../lib/list-inline-edit.js';

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
  const tab = url.searchParams.get('tab') || 'overview';

  const account = await one(
    env.DB,
    `SELECT a.*, u.display_name AS owner_name, u.email AS owner_email
       FROM accounts a
       LEFT JOIN users u ON u.id = a.owner_user_id
      WHERE a.id = ?
        AND a.deleted_at IS NULL`,
    [accountId]
  );
  if (!account) return notFound(context);

  // Fire-and-forget entity-view audit (deduplicated per user per 5 min)
  if (user?.id) {
    context.waitUntil(auditViewDeduped(env.DB, { entityType: 'account', entityId: accountId, user }).catch(() => {}));
  }

  const contacts = await all(
    env.DB,
    `SELECT id, first_name, last_name, title, email, phone, mobile
       FROM contacts
      WHERE account_id = ?
        AND deleted_at IS NULL
      ORDER BY last_name, first_name`,
    [accountId]
  );

  const addresses = await loadAddresses(env.DB, accountId);

  // Siblings in the same parent_group, if any. Used both for the
  // sidebar strip on this page and (indirectly) to tell the group
  // rollup link whether there is actually anything to show.
  const siblings = await loadSiblingAccounts(env, accountId, account.parent_group);
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

  // Pull every Katana customer for the in-page mapping picker. If the
  // API call fails (key missing, network blip), the picker shows the
  // current mapping (if any) and an inline error chip — the row never
  // breaks the page.
  let katanaCustomers = [];
  let katanaError = null;
  try {
    katanaCustomers = await apiGetAll(env, '/customers', {});
  } catch (err) {
    katanaError = String(err && err.message || err);
  }
  const katanaPickerState = {
    accountId: account.id,
    accountName: account.name || '',
    accountAlias: account.alias || '',
    katanaCustomerId:   account.katana_customer_id   || null,
    katanaCustomerName: account.katana_customer_name || '',
    katanaError,
    customers: katanaCustomers
      .map((kc) => ({ id: kc.id, name: (kc.name || '').trim() }))
      .filter((kc) => kc.name)
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
  const katanaPickerStateJson = JSON.stringify(katanaPickerState).replace(/</g, '\\u003c');

  // Related-records sections: opportunities, quotes, documents, and
  // tasks/activities for this account. Quotes reach the account via
  // the opportunities join; documents can be attached directly to the
  // account, to an opp, or to a quote on one of its opps. Tasks reach
  // it the same three ways (account_id, opportunity_id → account, or
  // quote_id → opportunity → account). Note-attachment documents
  // (those with `activity_id` set) are excluded — they render inline
  // with their note. All five queries run in parallel so the page
  // does not serialize on database latency.
  const [accountOpps, accountQuotes, accountDocs, accountTasks, stageCatalog] = await Promise.all([
    all(
      env.DB,
      `SELECT id, number, title, transaction_type, stage,
              estimated_value_usd, owner_user_id, updated_at, created_at
         FROM opportunities
        WHERE account_id = ?
          AND deleted_at IS NULL
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
          AND q.deleted_at IS NULL
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
          AND d.superseded_at IS NULL
          AND d.deleted_at IS NULL
        ORDER BY d.uploaded_at DESC
        LIMIT 100`,
      [accountId, accountId, accountId]
    ),
    all(
      env.DB,
      `SELECT a.id, a.type, a.subject, a.body, a.status, a.due_at,
              a.completed_at, a.direction, a.created_at,
              a.account_id, a.opportunity_id, a.quote_id,
              o.number AS opp_number, o.title AS opp_title,
              u.display_name AS assigned_name, u.email AS assigned_email
         FROM activities a
         LEFT JOIN opportunities o ON o.id = a.opportunity_id
         LEFT JOIN users u ON u.id = a.assigned_user_id
        WHERE (a.account_id = ?
           OR a.opportunity_id IN (SELECT id FROM opportunities WHERE account_id = ?)
           OR a.quote_id IN (SELECT q3.id FROM quotes q3
                              JOIN opportunities o3 ON o3.id = q3.opportunity_id
                             WHERE o3.account_id = ?))
          AND a.deleted_at IS NULL
        ORDER BY
          CASE WHEN a.status = 'pending' THEN 0 ELSE 1 END,
          CASE WHEN a.due_at IS NOT NULL THEN 0 ELSE 1 END,
          a.due_at ASC, a.created_at DESC
        LIMIT 100`,
      [accountId, accountId, accountId]
    ),
    loadStageCatalog(env.DB),
  ]);

  const TASK_TYPE_LABELS = { task: 'Task', note: 'Note', email: 'Email', call: 'Call', meeting: 'Meeting' };
  const taskRows = accountTasks;
  const taskBadgeCount = accountTasks.filter((t) => t.status === 'pending').length;

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
      stage: o.stage,
      value: o.estimated_value_usd,
      owner: userDisplayById.get(o.owner_user_id) ?? '',
      updated: (o.updated_at ?? '').slice(0, 10),
    };
  });
  // Split into active vs inactive (lost / abandoned). Won opps stay in
  // the active section until the downstream job finishes.
  const activeOppRows   = oppRows.filter((o) => !INACTIVE_OPPORTUNITY_STAGES.includes(o.stage));
  const inactiveOppRows = oppRows.filter((o) =>  INACTIVE_OPPORTUNITY_STAGES.includes(o.stage));
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
      uploaded: (d.uploaded_at ?? '').slice(0, 16).replace('T', ' '),
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

  const tasksTabPrefill = JSON.stringify({
    account_id: account.id,
    link_label: account.alias || account.name,
  });

  // Shared prefill for the "New contact" and "New opportunity" buttons on
  // this page. The account_label drives the pinned "Account: <name>" row
  // in the wizard, and account_id seeds the account step so the user
  // doesn't have to pick it.
  const acctWizardPrefill = JSON.stringify({
    account_id: account.id,
    account_label: account.alias || account.name,
  });

  // ---- Per-tab body fragments -------------------------------------------

  const overviewTab = html`
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
        <div class="header-actions" style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">
          ${user && user.email === 'wes.yoakum@c-lars.com' ? html`<button type="button" class="aii-page-capture-btn"
                  title="Capture an audio note for this account" aria-label="Capture audio note"
                  onclick="window.PipelineAICapture && window.PipelineAICapture.open({ refType: 'account', refId: '${escape(account.id)}', refLabel: '${escape((account.alias || account.name || '').slice(0, 60))}' })">
            <span class="aii-page-capture-icon">${raw(ICON_MIC)}</span>
          </button>` : ''}
          <form method="post" action="/accounts/${escape(account.id)}/delete"
                onsubmit="return window.Pipeline && Pipeline.confirmCascadeDelete(event, { entityType: 'account', entityId: '${escape(account.id)}', entityLabel: '${escape((account.alias || account.name || '').slice(0, 60))}' });"
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
        <div class="detail-pair" x-data="accountKatanaPicker()" x-init="init()">
          <span class="detail-label">Katana customer</span>
          <span class="detail-value">
            <!-- Mapped state -->
            <template x-if="katanaCustomerId">
              <span style="display:inline-flex;align-items:center;gap:.4rem;padding:.1rem .5rem;background:#e6f4ea;border:1px solid #9bcfa6;border-radius:3px;color:#1a7f37;font-size:.9em">
                <strong x-text="katanaCustomerName || ('#' + katanaCustomerId)"></strong>
                <span class="muted" style="font-size:.8em">#<span x-text="katanaCustomerId"></span></span>
                <button type="button" @click="unlink()" :disabled="busy" title="Unlink (Katana customer record stays)" style="border:0;background:transparent;cursor:pointer;font-size:1rem;line-height:1;padding:0;color:inherit">&times;</button>
              </span>
            </template>

            <!-- Unmapped state — picker + create -->
            <template x-if="!katanaCustomerId">
              <span style="display:inline-flex;align-items:center;gap:.4rem;flex-wrap:wrap">
                <select x-model="pickId" :disabled="busy || customers.length === 0" style="font-size:.85em;max-width:14rem">
                  <option value="">— pick from Katana —</option>
                  <template x-for="kc in customers" :key="kc.id">
                    <option :value="kc.id" x-text="kc.name"></option>
                  </template>
                </select>
                <button type="button" class="btn btn-xs" @click="link()" :disabled="busy || !pickId">Link</button>
                <button type="button" class="btn btn-xs" @click="createInKatana()" :disabled="busy" title="Create a new Katana customer using this account's name">+ Create in Katana</button>
                <span x-show="katanaError" x-cloak class="muted" style="font-size:.75em;color:#b3261e" :title="katanaError">&#9888; Katana unreachable</span>
              </span>
            </template>
          </span>
        </div>
      </div>

      <div class="inline-address-autosave">
        ${renderAddressEditor(addresses, { saveUrl: `/accounts/${account.id}/addresses` })}
      </div>

      <h3 style="margin-top:1rem">Notes</h3>
      ${inlineTextarea('notes', account.notes, { placeholder: 'Click to add notes…' })}

      ${account.intel_notes ? html`
        <h3 style="margin-top:1.25rem;display:flex;align-items:center;gap:0.5rem">
          <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#2566ff"></span>
          AI intel
          ${account.intel_updated_at ? html`<span class="muted" style="font-size:11px;font-weight:400">Updated ${escape(account.intel_updated_at.slice(0, 16).replace('T', ' '))}</span>` : ''}
        </h3>
        <div class="account-intel-notes" style="background:#f8fafc;border-left:3px solid #2566ff;padding:0.75rem 1rem;border-radius:0 6px 6px 0;font-size:13px;line-height:1.55;color:#1e293b">
          ${raw(renderMarkdown(account.intel_notes))}
        </div>
        <p class="muted" style="font-size:11px;margin-top:4px">Maintained by Claudia. Distinct from the Notes field above (which is for human edits).</p>
      ` : ''}
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
      : ''}`;

  const contactsTab = html`
    <section class="card">
      <div class="card-header">
        <h2>Contacts</h2>
        ${iconAddButton({
          onClick: `window.Pipeline && window.Pipeline.openWizard('contact', ${acctWizardPrefill})`,
          label: 'New contact',
        })}
      </div>

      ${(() => {
        const ctCols = [
          { key: 'first_name', label: 'First',    sort: 'text', filter: 'text', default: true },
          { key: 'last_name',  label: 'Last',     sort: 'text', filter: 'text', default: true },
          { key: 'title',      label: 'Title',    sort: 'text', filter: 'text', default: true },
          { key: 'email',      label: 'Email',    sort: 'text', filter: 'text', default: true },
          { key: 'phone',      label: 'Phone',    sort: 'text', filter: 'text', default: true },
          { key: 'actions',    label: '',          sort: null,   filter: null,   default: true, hideable: false },
        ];
        const ctData = contacts.map(c => ({
          id: c.id,
          first_name: c.first_name ?? '',
          last_name: c.last_name ?? '',
          title: c.title ?? '',
          email: c.email ?? '',
          phone: c.phone ?? '',
          actions: '',
        }));
        return contacts.length === 0
          ? html`<p class="muted">No contacts yet.</p>`
          : html`
            <div class="opp-list" data-list-id="acct-contacts" data-columns="${escape(JSON.stringify(ctCols))}">
              ${listToolbar({ id: 'acct-contacts', count: contacts.length, columns: ctCols, compact: true })}
              <table class="data opp-list-table">
                ${listTableHead(ctCols)}
                <tbody data-role="rows">
                  ${ctData.map((r, i) => html`<tr data-row-id="${escape(r.id)}"
                      ${raw(rowDataAttrs(ctCols, r))}>
                    <td class="col-first_name" data-col="first_name">${ieText('first_name', r.first_name)}</td>
                    <td class="col-last_name" data-col="last_name">${ieText('last_name', r.last_name)}</td>
                    <td class="col-title" data-col="title">${ieText('title', r.title)}</td>
                    <td class="col-email" data-col="email">${ieText('email', r.email, { inputType: 'email' })}</td>
                    <td class="col-phone" data-col="phone">${ieText('phone', r.phone, { inputType: 'tel' })}</td>
                    <td class="col-actions" data-col="actions" data-row-no-nav>
                      <form method="post" action="/contacts/${escape(r.id)}/delete"
                            onsubmit="return confirm('Delete this contact?');"
                            style="display:inline">
                        <button type="submit" class="btn btn-sm danger">Delete</button>
                      </form>
                    </td>
                  </tr>`)}
                </tbody>
              </table>
            </div>
            <script>${raw(listScript('pipeline.acct.contacts.v1', 'last_name', 'asc', {}, { listId: 'acct-contacts' }))}</script>
            <script>${raw(listInlineEditScript('/contacts/:id/patch', { listId: 'acct-contacts' }))}</script>`;
      })()}
    </section>`;

  const aoCols = [
    { key: 'number',      label: 'Number',   sort: 'text',   filter: 'text',   default: true },
    { key: 'title',       label: 'Title',    sort: 'text',   filter: 'text',   default: true },
    { key: 'typeLabel',   label: 'Type',     sort: 'text',   filter: 'select', default: true },
    { key: 'stageLabel',  label: 'Stage',    sort: 'text',   filter: 'select', default: true },
    { key: 'value',       label: 'Value',    sort: 'number', filter: null,     default: true },
    { key: 'owner',       label: 'Owner',    sort: 'text',   filter: 'text',   default: true },
    { key: 'updated',     label: 'Updated',  sort: 'date',   filter: 'text',   default: true },
  ];
  const renderOppListTable = (rows, listId, storageKey) => html`
    <div class="opp-list" data-list-id="${listId}" data-columns="${escape(JSON.stringify(aoCols))}">
      <table class="data opp-list-table compact">
        ${listTableHead(aoCols)}
        <tbody data-role="rows">
          ${rows.map(o => html`<tr data-row-id="${escape(o.id)}"
              data-row-href="/opportunities/${escape(o.id)}"
              ${raw(rowDataAttrs(aoCols, o))}>
            <td class="col-number" data-col="number"><a href="/opportunities/${escape(o.id)}"><code>${escape(o.number)}</code></a></td>
            <td class="col-title" data-col="title"><a href="/opportunities/${escape(o.id)}">${escape(o.title || '(untitled)')}</a></td>
            <td class="col-typeLabel" data-col="typeLabel">${escape(o.typeLabel)}</td>
            <td class="col-stageLabel" data-col="stageLabel"><span class="pill">${escape(o.stageLabel)}</span></td>
            <td class="col-value num" data-col="value">${escape(o.value != null ? fmtDollar(o.value) : '\u2014')}</td>
            <td class="col-owner" data-col="owner">${escape(o.owner)}</td>
            <td class="col-updated" data-col="updated"><small class="muted">${escape(o.updated)}</small></td>
          </tr>`)}
        </tbody>
      </table>
    </div>
    <script>${raw(listScript(storageKey, 'number', 'asc', {}, { listId }))}</script>`;

  const opportunitiesTab = html`
    <section class="card">
      <div class="card-header">
        <h2>Opportunities</h2>
        ${listToolbar({ id: 'acct-opps', count: activeOppRows.length, columns: aoCols, compact: true })}
        ${iconAddButton({
          onClick: `window.Pipeline && window.Pipeline.openWizard('opportunity', ${acctWizardPrefill})`,
          label: 'New opportunity',
        })}
      </div>
      ${oppRows.length === 0
        ? html`<p class="muted">No opportunities yet.</p>`
        : activeOppRows.length === 0
          ? html`<p class="muted">No active opportunities. See inactive below.</p>`
          : renderOppListTable(activeOppRows, 'acct-opps', 'pipeline.acct.opps.v1')}
    </section>
    ${inactiveOppRows.length > 0 ? html`
      <section class="card">
        <div class="card-header">
          <h2>Inactive opportunities</h2>
          <span class="muted">Lost or abandoned. Kept here for history.</span>
        </div>
        ${renderOppListTable(inactiveOppRows, 'acct-opps-inactive', 'pipeline.acct.opps.inactive.v1')}
      </section>
    ` : ''}`;

  const aqCols = [
    { key: 'number',      label: 'Number',       sort: 'text',   filter: 'text',   default: true },
    { key: 'revision',    label: 'Rev',           sort: 'text',   filter: 'text',   default: true },
    { key: 'typeLabel',   label: 'Type',          sort: 'text',   filter: 'select', default: true },
    { key: 'title',       label: 'Title',         sort: 'text',   filter: 'text',   default: true },
    { key: 'opp',         label: 'Opportunity',   sort: 'text',   filter: 'text',   default: true },
    { key: 'statusLabel', label: 'Status',        sort: 'text',   filter: 'select', default: true },
    { key: 'total',       label: 'Total',         sort: 'number', filter: null,     default: true },
    { key: 'validUntil',  label: 'Valid until',   sort: 'date',   filter: 'text',   default: true },
    { key: 'updated',     label: 'Updated',       sort: 'date',   filter: 'text',   default: true },
  ];
  const aqData = quoteRows.map(q => ({
    ...q,
    opp: `${q.oppNumber} ${q.oppTitle}`.trim(),
  }));
  const quotesTab = html`
    <section class="card">
      <div class="card-header">
        <h2>Quotes</h2>
        ${listToolbar({ id: 'acct-quotes', count: quoteRows.length, columns: aqCols, compact: true })}
      </div>
      ${quoteRows.length === 0
        ? html`<p class="muted">No quotes yet.</p>`
        : html`
          <div class="opp-list" data-list-id="acct-quotes" data-columns="${escape(JSON.stringify(aqCols))}">
            <table class="data opp-list-table compact">
              ${listTableHead(aqCols)}
              <tbody data-role="rows">
                ${aqData.map(q => html`<tr data-row-id="${escape(q.id)}"
                    data-row-href="/opportunities/${escape(q.opportunity_id)}/quotes/${escape(q.id)}"
                    ${raw(rowDataAttrs(aqCols, q))}>
                  <td class="col-number" data-col="number"><a href="/opportunities/${escape(q.opportunity_id)}/quotes/${escape(q.id)}"><code>${escape(q.number)}</code></a></td>
                  <td class="col-revision" data-col="revision">${escape(q.revision)}</td>
                  <td class="col-typeLabel" data-col="typeLabel">${escape(q.typeLabel)}</td>
                  <td class="col-title" data-col="title">${escape(q.title || '(no title)')}</td>
                  <td class="col-opp" data-col="opp"><a href="/opportunities/${escape(q.opportunity_id)}"><code>${escape(q.oppNumber)}</code> ${escape(q.oppTitle)}</a></td>
                  <td class="col-statusLabel" data-col="statusLabel"><span class="pill ${quoteStatusPillClass(q.status)}">${escape(q.statusLabel)}</span></td>
                  <td class="col-total num" data-col="total">${escape(q.total != null ? fmtDollar(q.total) : '\u2014')}</td>
                  <td class="col-validUntil" data-col="validUntil"><small class="muted">${escape(q.validUntil)}</small></td>
                  <td class="col-updated" data-col="updated"><small class="muted">${escape(q.updated)}</small></td>
                </tr>`)}
              </tbody>
            </table>
          </div>
          <script>${raw(listScript('pipeline.acct.quotes.v1', 'number', 'desc', {}, { listId: 'acct-quotes' }))}</script>
        `}
    </section>`;

  const atCols = [
    { key: 'check',    label: '',          sort: null,     filter: null,     default: true, hideable: false },
    { key: 'subject',  label: 'Subject',   sort: 'text',   filter: 'text',   default: true },
    { key: 'type',     label: 'Type',      sort: 'text',   filter: 'select', default: true },
    { key: 'linked',   label: 'Linked to', sort: 'text',   filter: 'text',   default: true },
    { key: 'assigned', label: 'Assigned',  sort: 'text',   filter: 'text',   default: true },
    { key: 'due',      label: 'Due',       sort: 'date',   filter: 'text',   default: true },
    { key: 'status',   label: 'Status',    sort: 'text',   filter: 'select', default: true },
    { key: 'actions',  label: '',          sort: null,     filter: null,     default: true, hideable: false },
  ];
  const atData = taskRows.map(a => {
    const isOverdue = a.status === 'pending' && a.due_at && a.due_at < new Date().toISOString().slice(0, 10);
    return {
      id: a.id,
      check: '',
      subject: a.subject || '(no subject)',
      body_preview: a.body ? (a.body.length > 60 ? a.body.slice(0, 60) + '...' : a.body) : '',
      type: TASK_TYPE_LABELS[a.type] ?? a.type,
      type_raw: a.type,
      linked: a.opportunity_id ? (a.opp_number ?? '') : 'Account',
      opportunity_id: a.opportunity_id ?? '',
      assigned: a.assigned_name ?? a.assigned_email ?? '',
      due: a.due_at ? a.due_at.slice(0, 10) : '',
      status: a.status ?? '',
      is_completed: a.status === 'completed',
      is_overdue: isOverdue,
      actions: '',
    };
  });
  const tasksTab = html`
    <section class="card">
      <div class="card-header">
        <h2>Tasks &amp; Activities</h2>
        ${listToolbar({ id: 'acct-tasks', count: taskRows.length, columns: atCols, compact: true })}
        <button class="btn btn-sm primary" type="button"
                onclick="window.Pipeline && window.Pipeline.openTaskModal(${escape(tasksTabPrefill)})">+ Add task</button>
      </div>
      ${taskRows.length === 0
        ? html`<p class="muted">No tasks or activities yet.</p>`
        : html`
          <div class="opp-list" data-list-id="acct-tasks" data-columns="${escape(JSON.stringify(atCols))}">
            <table class="data opp-list-table compact">
              ${listTableHead(atCols)}
              <tbody data-role="rows">
                ${atData.map(r => html`<tr data-row-id="${escape(r.id)}"
                    data-row-href="/activities/${escape(r.id)}"
                    ${raw(rowDataAttrs(atCols, r))}
                    class="${r.is_completed ? 'row-muted' : ''} ${r.is_overdue ? 'row-overdue' : ''}">
                  <td class="col-check" data-col="check" data-row-no-nav style="width:2rem">${r.is_completed
                    ? html`<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--green,#1a7f37)" stroke-width="2"><circle cx="8" cy="8" r="6"/><path d="M5 8l2 2 4-4"/></svg>`
                    : html`<form method="post" action="/activities/${escape(r.id)}/complete" style="display:inline"><button type="submit" class="check-btn" title="Mark complete"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="6"/></svg></button></form>`}</td>
                  <td class="col-subject" data-col="subject"><a href="/activities/${escape(r.id)}"><strong class="${r.is_completed ? 'completed-text' : ''}">${escape(r.subject)}</strong></a>
                    ${r.body_preview ? html`<br><small class="muted">${escape(r.body_preview)}</small>` : ''}</td>
                  <td class="col-type" data-col="type"><span class="pill pill-${r.type_raw}">${escape(r.type)}</span></td>
                  <td class="col-linked" data-col="linked">${r.opportunity_id
                    ? html`<a href="/opportunities/${escape(r.opportunity_id)}"><code>${escape(r.linked)}</code></a>`
                    : html`<span class="muted">Account</span>`}</td>
                  <td class="col-assigned" data-col="assigned">${escape(r.assigned || '\u2014')}</td>
                  <td class="col-due" data-col="due" class="${r.is_overdue ? 'overdue-text' : ''}">${r.due ? escape(r.due) : html`<span class="muted">\u2014</span>`}</td>
                  <td class="col-status" data-col="status"><span class="pill ${r.is_completed ? 'pill-success' : ''}">${escape(r.status || '\u2014')}</span></td>
                  <td class="col-actions" data-col="actions" data-row-no-nav>
                    <form method="post" action="/activities/${escape(r.id)}/delete" style="display:inline" onsubmit="return confirm('Delete this task?')">
                      <input type="hidden" name="return_to" value="/accounts/${escape(account.id)}?tab=tasks">
                      <button type="submit" class="row-delete-btn" title="Delete task" aria-label="Delete task">&times;</button>
                    </form>
                  </td>
                </tr>`)}
              </tbody>
            </table>
          </div>
          <script>${raw(listScript('pipeline.acct.tasks.v1', 'due', 'asc', {}, { listId: 'acct-tasks' }))}</script>`}
    </section>`;

  const adCols = [
    { key: 'kindLabel',  label: 'Kind',       sort: 'text',   filter: 'select', default: true },
    { key: 'title',      label: 'Title',      sort: 'text',   filter: 'text',   default: true },
    { key: 'linkedTo',   label: 'Linked to',  sort: 'text',   filter: 'text',   default: true },
    { key: 'size',       label: 'Size',       sort: 'text',   filter: null,     default: true },
    { key: 'uploaded',   label: 'Uploaded',   sort: 'date',   filter: 'text',   default: true },
    { key: 'actions',    label: '',           sort: null,      filter: null,     default: true, hideable: false },
  ];
  const docsTab = html`
    <section class="card">
      <div class="card-header">
        <h2>Documents</h2>
        ${listToolbar({ id: 'acct-docs', count: docRows.length, columns: adCols, compact: true })}
        <a class="btn" href="/documents/library">Open library</a>
      </div>
      ${docRows.length === 0
        ? html`<p class="muted">No documents yet.</p>`
        : html`
          <div class="opp-list" data-list-id="acct-docs" data-columns="${escape(JSON.stringify(adCols))}">
            <table class="data opp-list-table compact">
              ${listTableHead(adCols)}
              <tbody data-role="rows">
                ${docRows.map(d => html`<tr data-row-id="${escape(d.id)}"
                    ${raw(rowDataAttrs(adCols, d))}>
                  <td class="col-kindLabel" data-col="kindLabel"><span class="pill">${escape(d.kindLabel)}</span></td>
                  <td class="col-title" data-col="title"><a href="/documents/${escape(d.id)}/download" target="_blank" rel="noopener" title="Open in new tab">${escape(d.title)}</a></td>
                  <td class="col-linkedTo" data-col="linkedTo">${d.linkedHref
                    ? html`<a href="${escape(d.linkedHref)}">${escape(d.linkedTo)}</a>`
                    : html`<small class="muted">${escape(d.linkedTo)}</small>`}</td>
                  <td class="col-size num" data-col="size"><small class="muted">${escape(d.size)}</small></td>
                  <td class="col-uploaded" data-col="uploaded"><small class="muted">${escape(d.uploaded)}</small></td>
                  <td class="col-actions" data-col="actions" data-row-no-nav style="white-space:nowrap">
                    <a class="btn btn-sm" href="/documents/${escape(d.id)}/download?download=1" title="Force download">Download</a>
                    <form method="post" action="/documents/${escape(d.id)}/delete" style="display:inline" onsubmit="return confirm('Delete this document?')">
                      <input type="hidden" name="return_to" value="/accounts/${escape(account.id)}?tab=docs">
                      <button class="btn btn-sm danger" type="submit">Delete</button>
                    </form>
                  </td>
                </tr>`)}
              </tbody>
            </table>
          </div>
          <script>${raw(listScript('pipeline.acct.docs.v1', 'uploaded', 'desc', {}, { listId: 'acct-docs' }))}</script>
        `}
    </section>`;

  const historyTab = html`
    <section class="card">
      <h2>History</h2>
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
    </section>`;

  // ---- Tab nav -----------------------------------------------------------

  const tabs = html`
    <nav class="card" style="padding: 0.5rem 1rem;">
      <a class="nav-link ${tab === 'overview' ? 'active' : ''}" href="/accounts/${escape(account.id)}">Overview</a>
      <a class="nav-link ${tab === 'contacts' ? 'active' : ''}" href="/accounts/${escape(account.id)}?tab=contacts">Contacts (${contacts.length})</a>
      <a class="nav-link ${tab === 'opportunities' ? 'active' : ''}" href="/accounts/${escape(account.id)}?tab=opportunities">Opportunities (${oppRows.length})</a>
      <a class="nav-link ${tab === 'quotes' ? 'active' : ''}" href="/accounts/${escape(account.id)}?tab=quotes">Quotes (${quoteRows.length})</a>
      <a class="nav-link ${tab === 'tasks' ? 'active' : ''}" href="/accounts/${escape(account.id)}?tab=tasks">Tasks${taskBadgeCount > 0 ? ` (${taskBadgeCount})` : ''}</a>
      <a class="nav-link ${tab === 'docs' ? 'active' : ''}" href="/accounts/${escape(account.id)}?tab=docs">Docs (${docRows.length})</a>
      <a class="nav-link ${tab === 'history' ? 'active' : ''}" href="/accounts/${escape(account.id)}?tab=history">History (${events.length})</a>
    </nav>`;

  const activeTab =
    tab === 'contacts' ? contactsTab :
    tab === 'opportunities' ? opportunitiesTab :
    tab === 'quotes' ? quotesTab :
    tab === 'tasks' ? tasksTab :
    tab === 'docs' ? docsTab :
    tab === 'history' ? historyTab :
    overviewTab;

  const body = html`
    ${tabs}
    ${activeTab}

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
              document.title = data.value + ' \u2014 Pipeline';
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

    // Katana customer picker — inline mapper on the account detail
    // page. Reuses the existing /settings/katana-customer-map/{link,
    // unlink, create} routes so saves are audit-logged the same way.
    window.__ACCOUNT_KATANA_STATE__ = ${raw(katanaPickerStateJson)};
    document.addEventListener('alpine:init', function () {
      Alpine.data('accountKatanaPicker', function () {
        var s = window.__ACCOUNT_KATANA_STATE__ || {};
        return {
          accountId: s.accountId,
          accountName: s.accountName || '',
          accountAlias: s.accountAlias || '',
          katanaCustomerId: s.katanaCustomerId || null,
          katanaCustomerName: s.katanaCustomerName || '',
          customers: s.customers || [],
          katanaError: s.katanaError || null,
          pickId: '',
          busy: false,
          init: function () {},
          link: function () {
            if (!this.pickId) return;
            var picked = this.customers.find(function (kc) { return String(kc.id) === String(this.pickId); }, this);
            if (!picked) return;
            var self = this;
            self.busy = true;
            fetch('/settings/katana-customer-map/link', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                account_id: self.accountId,
                katana_customer_id: picked.id,
                katana_customer_name: picked.name,
              }),
            }).then(function (r) {
              if (!r.ok) return r.json().then(function (d) { throw new Error(d && d.error || ('HTTP ' + r.status)); });
              return r.json();
            }).then(function () {
              self.katanaCustomerId = picked.id;
              self.katanaCustomerName = picked.name;
              self.pickId = '';
              self.busy = false;
            }).catch(function (err) {
              self.busy = false;
              alert('Could not link: ' + (err && err.message ? err.message : 'unknown error'));
            });
          },
          unlink: function () {
            if (!confirm('Unlink ' + this.accountName + ' from Katana customer "' + (this.katanaCustomerName || this.katanaCustomerId) + '"?')) return;
            var self = this;
            self.busy = true;
            fetch('/settings/katana-customer-map/unlink', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ account_id: self.accountId }),
            }).then(function (r) {
              if (!r.ok) return r.json().then(function (d) { throw new Error(d && d.error || ('HTTP ' + r.status)); });
              return r.json();
            }).then(function () {
              self.katanaCustomerId = null;
              self.katanaCustomerName = '';
              self.busy = false;
            }).catch(function (err) {
              self.busy = false;
              alert('Could not unlink: ' + (err && err.message ? err.message : 'unknown error'));
            });
          },
          createInKatana: function () {
            var seed = (this.accountAlias || this.accountName || '').trim();
            if (!seed) { alert('Account has no name to use.'); return; }
            var defaultName = seed.length > 60 ? seed.slice(0, 60) : seed;
            var katanaName = prompt('Create a new Katana customer with this name?', defaultName);
            if (!katanaName) return;
            katanaName = katanaName.trim();
            if (!katanaName) return;
            var self = this;
            self.busy = true;
            fetch('/settings/katana-customer-map/create', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ account_id: self.accountId, katana_name: katanaName }),
            }).then(function (r) {
              if (!r.ok) return r.json().then(function (d) { throw new Error(d && d.error || ('HTTP ' + r.status)); });
              return r.json();
            }).then(function (data) {
              self.katanaCustomerId = data.katana_customer_id;
              self.katanaCustomerName = data.katana_customer_name;
              if (data.katana_customer_id && !self.customers.some(function (kc) { return kc.id === data.katana_customer_id; })) {
                self.customers.push({ id: data.katana_customer_id, name: data.katana_customer_name });
                self.customers.sort(function (a, b) { return a.name.localeCompare(b.name); });
              }
              self.busy = false;
            }).catch(function (err) {
              self.busy = false;
              alert('Could not create in Katana: ' + (err && err.message ? err.message : 'unknown error'));
            });
          },
        };
      });
    });

    </script>
  `;

  // AI Inbox in-context capture: load the recorder + capture modal
  // scripts on this page so the "Capture" button works. Gated to the
  // same user as /ai-inbox itself.
  const captureScripts = (user && user.email === 'wes.yoakum@c-lars.com')
    ? html`<script defer src="/js/audio-recorder.js"></script><script defer src="/js/ai-capture.js"></script>`
    : '';

  return htmlResponse(
    layout(account.name, html`${body}${captureScripts}`, {
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
  // submitted list (first default-or-first wins per kind). 'both' rows
  // show up under both billing and physical.
  const isBilling = (a) => a.kind === 'billing' || a.kind === 'both';
  const isPhysical = (a) => a.kind === 'physical' || a.kind === 'both';
  const firstBilling =
    submittedAddresses.find((a) => isBilling(a) && a.is_default) ||
    submittedAddresses.find((a) => isBilling(a));
  const firstPhysical =
    submittedAddresses.find((a) => isPhysical(a) && a.is_default) ||
    submittedAddresses.find((a) => isPhysical(a));

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
