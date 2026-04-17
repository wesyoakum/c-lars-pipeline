// functions/accounts/index.js
//
// GET  /accounts        — list all accounts with sort/filter/search
// POST /accounts        — create a new account (called by the new form)

import { all, stmt, batch } from '../lib/db.js';
import { auditStmt } from '../lib/audit.js';
import { validateAccount } from '../lib/validators.js';
import { layout, htmlResponse, html, raw, escape, subnavTabs } from '../lib/layout.js';
import { uuid, now } from '../lib/ids.js';
import {
  redirectWithFlash,
  formBody,
  readFlash,
  isPopupMode,
  popupCloseResponse,
} from '../lib/http.js';
import { parseAddressForm, buildAddressStatements } from '../lib/address_editor.js';
import { listScript, listTableHead, listToolbar, rowDataAttrs } from '../lib/list-table.js';
import { ieText, ieSelect, listInlineEditScript } from '../lib/list-inline-edit.js';
import { listBulkEditScript } from '../lib/list-bulk-edit.js';

// Keep in sync with functions/accounts/[id]/index.js::SEGMENT_OPTIONS.
// Used by the inline-edit select in the segment column.
const SEGMENT_OPTIONS = [
  { value: '', label: '— None —' },
  { value: 'WROV', label: 'WROV' },
  { value: 'Research', label: 'Research' },
  { value: 'Defense', label: 'Defense' },
  { value: 'Commercial', label: 'Commercial' },
  { value: 'Other', label: 'Other' },
];

// Active/Inactive options for the Status inline-edit select.
// String values (not 0/1) so list-table's select-filter dropdown shows
// them verbatim and the patch handler's coerce() maps them back to ints.
const ACTIVE_OPTIONS = [
  { value: 'active',   label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];

/**
 * GET /accounts — list accounts with full client-side sort/filter/search.
 */
export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);

  const rows = await all(
    env.DB,
    `SELECT a.id, a.name, a.alias, a.parent_group, a.segment, a.phone, a.website, a.updated_at,
            a.is_active,
            (SELECT COUNT(*) FROM contacts c WHERE c.account_id = a.id) AS contact_count,
            (SELECT COUNT(*) FROM opportunities o WHERE o.account_id = a.id) AS opp_count
       FROM accounts a
      ORDER BY a.name
      LIMIT 500`
  );

  // Collect the set of distinct parent_group labels already in use so
  // the inline-edit select for that column can offer them as options.
  // Includes a trailing "+ Add new group…" sentinel that the client
  // controller swaps for a free-text input when picked.
  const existingGroupLabels = Array.from(
    new Set(rows.map((r) => r.parent_group).filter(Boolean))
  ).sort();
  const groupOptions = [
    { value: '', label: '— None —' },
    ...existingGroupLabels.map((g) => ({ value: g, label: g })),
    { value: '__new__', label: '+ Add new group\u2026' },
  ];

  const columns = [
    { key: 'open',          label: '\u2197',    sort: 'text',   filter: null,     default: true },
    { key: 'name',          label: 'Name',      sort: 'text',   filter: 'text',   default: true },
    { key: 'alias',         label: 'Alias',     sort: 'text',   filter: 'text',   default: true },
    { key: 'parent_group',  label: 'Group',     sort: 'text',   filter: 'select', default: false },
    { key: 'segment',       label: 'Segment',   sort: 'text',   filter: 'select', default: true },
    { key: 'status',        label: 'Status',    sort: 'text',   filter: 'select', default: true },
    { key: 'phone',         label: 'Phone',     sort: 'text',   filter: 'text',   default: true },
    { key: 'contact_count', label: 'Contacts',  sort: 'number', filter: 'range',  default: true },
    { key: 'opp_count',     label: 'Opps',      sort: 'number', filter: 'range',  default: true },
    { key: 'website',       label: 'Website',   sort: 'text',   filter: 'text',   default: false },
    { key: 'updated',       label: 'Updated',   sort: 'date',   filter: 'text',   default: true },
  ];

  const rowData = rows.map(r => ({
    id: r.id,
    // `name` is the quicksearch text blob (name + alias + parent_group
    // joined) so typing "helix", "HR" (alias), or "Super Big Corp"
    // (group) all find Helix Robotics Inc. After an inline edit the
    // client rebuilds this from data-name_display / data-alias /
    // data-parent_group via the data-combined-name hint on the row.
    name: [r.name ?? '', r.alias ?? '', r.parent_group ?? '']
      .filter(Boolean)
      .join(' '),
    name_display: r.name ?? '',
    // Raw alias. Unaliased rows sort as empty strings (list-table.js
    // pushes empty/null to the end). Display uses a muted fallback to
    // the name, handled by ieText({ fallbackText }).
    alias: r.alias ?? '',
    parent_group: r.parent_group ?? '',
    segment: r.segment ?? '',
    // `status` is the string form ('active'/'inactive') used by the
    // inline-edit select, the select-filter dropdown, and sort. The
    // raw 0/1 lives on `is_active` for any callers that care.
    is_active: r.is_active,
    status: r.is_active === 0 ? 'inactive' : 'active',
    phone: r.phone ?? '',
    contact_count: r.contact_count ?? 0,
    opp_count: r.opp_count ?? 0,
    website: r.website ?? '',
    updated: (r.updated_at ?? '').slice(0, 10),
  }));

  const tabs = subnavTabs(
    [
      { href: '/accounts', label: 'Accounts' },
      { href: '/accounts/contacts', label: 'Contacts' },
    ],
    '/accounts'
  );

  const body = html`
    ${tabs}
    <section class="card">
      <div class="card-header">
        <h1 class="page-title">Accounts</h1>
        ${listToolbar({ id: 'acct', count: rows.length, columns, newOnClick: "window.PMS.openWizard('account', {})", newLabel: 'New account', bulk: true })}
      </div>

      ${rows.length === 0
        ? html`<p class="muted">
            No accounts yet. Start by
            <a href="/accounts/new">creating one</a>.
          </p>`
        : html`
          <div class="opp-list" data-columns="${escape(JSON.stringify(columns))}">
            <table class="data opp-list-table">
              ${listTableHead(columns, rowData)}
              <tbody data-role="rows">
                ${rowData.map(r => html`
                  <tr data-row-id="${escape(r.id)}"
                      data-name_display="${escape(r.name_display)}"
                      data-combined-name="name_display alias parent_group"
                      ${raw(rowDataAttrs(columns, r))}>
                    <td class="col-open" data-col="open">
                      <a class="row-open-link" href="/accounts/${escape(r.id)}" title="Open account" aria-label="Open account">\u2197</a>
                    </td>
                    <td class="col-name" data-col="name">
                      ${ieText('name', r.name_display)}
                    </td>
                    <td class="col-alias" data-col="alias">
                      ${ieText('alias', r.alias, { fallbackText: r.name_display })}
                    </td>
                    <td class="col-parent_group" data-col="parent_group">
                      ${ieSelect('parent_group', r.parent_group, groupOptions, { allowNew: true })}
                    </td>
                    <td class="col-segment" data-col="segment">
                      ${ieSelect('segment', r.segment, SEGMENT_OPTIONS)}
                    </td>
                    <td class="col-status" data-col="status">
                      ${ieSelect('is_active', r.status, ACTIVE_OPTIONS)}
                    </td>
                    <td class="col-phone" data-col="phone">
                      ${ieText('phone', r.phone, { inputType: 'tel' })}
                    </td>
                    <td class="col-contact_count num" data-col="contact_count">${r.contact_count}</td>
                    <td class="col-opp_count num" data-col="opp_count">${r.opp_count}</td>
                    <td class="col-website" data-col="website">
                      ${ieText('website', r.website, { inputType: 'url' })}
                    </td>
                    <td class="col-updated" data-col="updated"><small class="muted">${escape(r.updated)}</small></td>
                  </tr>
                `)}
              </tbody>
            </table>
          </div>
          <script>${raw(listScript('pms.accounts.v1', 'name', 'asc'))}</script>
          <script>${raw(listInlineEditScript('/accounts/:id/patch', {
            // Column key `status` ↔ patch field `is_active`. The patch
            // handler accepts 'active'/'inactive' string values and
            // coerces them to 0/1 for storage.
            fieldAttrMap: { is_active: 'status' },
          }))}</script>
          <script>${raw(listBulkEditScript({
            patchUrl: '/accounts/:id/patch',
            deleteUrl: '/accounts/:id/delete',
          }))}</script>
        `}
    </section>
  `;

  return htmlResponse(
    layout('Accounts', body, {
      user,
      env: data?.env,
      activeNav: '/accounts',
      flash: readFlash(url),
      breadcrumbs: [{ label: 'Accounts' }],
    })
  );
}

/**
 * Detects a request coming from the wizard modal or any XHR-style
 * client. We check three signals:
 *   - the wizard posts `source=wizard` in the form body
 *   - most clients send `x-requested-with: XMLHttpRequest`
 *   - an `accept: application/json` header with no text/html preference
 * Any of those is enough to switch the handler into JSON mode.
 */
function isAjaxRequest(request, input) {
  if (input?.source === 'wizard' || input?.source === 'modal') return true;
  const xrw = request.headers.get('x-requested-with');
  if (xrw && xrw.toLowerCase() === 'xmlhttprequest') return true;
  const accept = request.headers.get('accept') || '';
  return accept.includes('application/json') && !accept.includes('text/html');
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/**
 * POST /accounts — create a new account.
 *
 * Three response modes:
 *   1. AJAX (source=wizard, x-requested-with, or JSON accept header):
 *      returns { ok: true, id, redirectUrl } or { ok: false, error, errors }
 *   2. Popup mode (isPopupMode true): postMessage + close the popup
 *   3. Classic form submit: re-render with errors or redirect-with-flash
 */
export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const input = await formBody(request);
  const ajax = isAjaxRequest(request, input);
  const { ok, value, errors } = validateAccount(input);
  const submittedAddresses = parseAddressForm(input);

  if (!ok) {
    if (ajax) {
      const firstError = Object.values(errors)[0] || 'Invalid input.';
      return jsonResponse({ ok: false, error: firstError, errors }, 400);
    }
    // Re-render the new form with the errors inline. Hand back the parsed
    // address rows so the user doesn't lose them.
    const { renderNewForm } = await import('./new.js');
    return renderNewForm(context, {
      values: input,
      errors,
      addresses: submittedAddresses,
    });
  }

  const id = uuid();
  const ts = now();

  // Denormalized convenience columns on accounts: pick the first default
  // billing / physical (or just the first of each kind) so legacy readers
  // that still hit accounts.address_billing / address_physical keep working.
  const firstBilling =
    submittedAddresses.find((a) => a.kind === 'billing' && a.is_default) ||
    submittedAddresses.find((a) => a.kind === 'billing');
  const firstPhysical =
    submittedAddresses.find((a) => a.kind === 'physical' && a.is_default) ||
    submittedAddresses.find((a) => a.kind === 'physical');

  const statements = [
    stmt(
      env.DB,
      `INSERT INTO accounts
         (id, name, alias, segment, address_billing, address_physical,
          phone, website, notes, owner_user_id, is_active,
          created_at, updated_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        value.name,
        value.alias,
        value.segment,
        firstBilling?.address ?? null,
        firstPhysical?.address ?? null,
        value.phone,
        value.website,
        value.notes,
        value.owner_user_id ?? user?.id ?? null,
        value.is_active,
        ts,
        ts,
        user?.id ?? null,
      ]
    ),
  ];

  // Insert the normalized address rows (no existing rows on create).
  const { statements: addrStmts } = buildAddressStatements(
    env.DB,
    id,
    submittedAddresses,
    [],
    user
  );
  statements.push(...addrStmts);

  statements.push(
    auditStmt(env.DB, {
      entityType: 'account',
      entityId: id,
      eventType: 'created',
      user,
      summary: `Created account "${value.name}"`,
      changes: { ...value, address_count: submittedAddresses.length },
    })
  );

  await batch(env.DB, statements);

  if (ajax) {
    return jsonResponse({
      ok: true,
      id,
      name: value.name,
      redirectUrl: `/accounts/${id}`,
    });
  }

  if (isPopupMode(request, input)) {
    return popupCloseResponse('pms.account.created', {
      account: { id, name: value.name },
    });
  }

  return redirectWithFlash(`/accounts/${id}`, `Account "${value.name}" created.`);
}
