// functions/accounts/index.js
//
// GET  /accounts        — list all accounts with sort/filter/search
// POST /accounts        — create a new account (called by the new form)

import { all, stmt, batch } from '../lib/db.js';
import { auditStmt } from '../lib/audit.js';
import { validateAccount } from '../lib/validators.js';
import { layout, htmlResponse, html, raw, escape } from '../lib/layout.js';
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
            (SELECT COUNT(*) FROM contacts c WHERE c.account_id = a.id) AS contact_count,
            (SELECT COUNT(*) FROM opportunities o WHERE o.account_id = a.id) AS opp_count
       FROM accounts a
      ORDER BY a.name
      LIMIT 500`
  );

  const columns = [
    { key: 'name',          label: 'Name',      sort: 'text',   filter: 'text',   default: true },
    { key: 'parent_group',  label: 'Group',     sort: 'text',   filter: 'select', default: false },
    { key: 'segment',       label: 'Segment',   sort: 'text',   filter: 'select', default: true },
    { key: 'phone',         label: 'Phone',     sort: 'text',   filter: 'text',   default: true },
    { key: 'contact_count', label: 'Contacts',  sort: 'number', filter: null,     default: true },
    { key: 'opp_count',     label: 'Opps',      sort: 'number', filter: null,     default: true },
    { key: 'website',       label: 'Website',   sort: 'text',   filter: 'text',   default: false },
    { key: 'updated',       label: 'Updated',   sort: 'date',   filter: 'text',   default: true },
  ];

  const rowData = rows.map(r => ({
    id: r.id,
    // Combine name + alias + parent group into the filter data so the
    // quicksearch matches any of them — typing "helix", "HR" (alias),
    // or "Super Big Corp" (group) all find Helix Robotics Inc.
    name: [r.name ?? '', r.alias ?? '', r.parent_group ?? '']
      .filter(Boolean)
      .join(' '),
    name_display: r.name ?? '',
    alias: r.alias ?? '',
    parent_group: r.parent_group ?? '',
    segment: r.segment ?? '',
    phone: r.phone ?? '',
    contact_count: r.contact_count ?? 0,
    opp_count: r.opp_count ?? 0,
    website: r.website ?? '',
    updated: (r.updated_at ?? '').slice(0, 10),
  }));

  const body = html`
    <section class="card">
      <div class="card-header">
        <h1 class="page-title">Accounts</h1>
        ${listToolbar({ id: 'acct', count: rows.length, columns, newHref: '/accounts/new', newLabel: 'New account' })}
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
                      ${raw(rowDataAttrs(columns, r))}>
                    <td class="col-name" data-col="name">
                      <a href="/accounts/${escape(r.id)}">${escape(r.name_display)}</a>${r.alias ? html` <span class="muted">(${escape(r.alias)})</span>` : ''}
                    </td>
                    <td class="col-parent_group" data-col="parent_group">${escape(r.parent_group)}</td>
                    <td class="col-segment" data-col="segment">${escape(r.segment)}</td>
                    <td class="col-phone" data-col="phone">${escape(r.phone)}</td>
                    <td class="col-contact_count num" data-col="contact_count">${r.contact_count}</td>
                    <td class="col-opp_count num" data-col="opp_count">${r.opp_count}</td>
                    <td class="col-website" data-col="website">
                      ${r.website ? html`<a href="${escape(r.website)}" target="_blank" rel="noopener">${escape(r.website.replace(/^https?:\/\//, ''))}</a>` : ''}
                    </td>
                    <td class="col-updated" data-col="updated"><small class="muted">${escape(r.updated)}</small></td>
                  </tr>
                `)}
              </tbody>
            </table>
          </div>
          <script>${raw(listScript('pms.accounts.v1', 'name', 'asc'))}</script>
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
 * POST /accounts — create a new account.
 */
export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const input = await formBody(request);
  const { ok, value, errors } = validateAccount(input);
  const submittedAddresses = parseAddressForm(input);

  if (!ok) {
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
         (id, name, segment, address_billing, address_physical,
          phone, website, notes, owner_user_id,
          created_at, updated_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        value.name,
        value.segment,
        firstBilling?.address ?? null,
        firstPhysical?.address ?? null,
        value.phone,
        value.website,
        value.notes,
        value.owner_user_id ?? user?.id ?? null,
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

  if (isPopupMode(request, input)) {
    return popupCloseResponse('pms.account.created', {
      account: { id, name: value.name },
    });
  }

  return redirectWithFlash(`/accounts/${id}`, `Account "${value.name}" created.`);
}
