// functions/accounts/contacts.js
//
// GET /accounts/contacts — list ALL contacts across ALL accounts with
// sort/filter/search and inline editing. Companion to /accounts which
// lists accounts. Both pages share a subnav tab strip ("Accounts" |
// "Contacts") under the Accounts top-level nav.

import { all } from '../lib/db.js';
import { layout, htmlResponse, html, raw, escape, subnavTabs } from '../lib/layout.js';
import { readFlash } from '../lib/http.js';
import { listScript, listTableHead, listToolbar, rowDataAttrs } from '../lib/list-table.js';
import { ieText, ieSelect, listInlineEditScript } from '../lib/list-inline-edit.js';
import { listBulkEditScript } from '../lib/list-bulk-edit.js';

const PRIMARY_OPTIONS = [
  { value: '0', label: 'No' },
  { value: '1', label: 'Yes' },
];

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);

  const rows = await all(
    env.DB,
    `SELECT c.id,
            c.account_id,
            c.first_name,
            c.last_name,
            c.title,
            c.email,
            c.phone,
            c.mobile,
            c.is_primary,
            c.updated_at,
            a.name AS account_name
       FROM contacts c
       LEFT JOIN accounts a ON a.id = c.account_id
      ORDER BY COALESCE(c.last_name, c.first_name, '') COLLATE NOCASE, c.first_name COLLATE NOCASE
      LIMIT 2000`
  );

  const columns = [
    { key: 'open',         label: '\u2197',       sort: 'text',   filter: null,     default: true },
    { key: 'first_name',   label: 'First name',   sort: 'text',   filter: 'text',   default: true },
    { key: 'last_name',    label: 'Last name',    sort: 'text',   filter: 'text',   default: true },
    { key: 'account_name', label: 'Account',      sort: 'text',   filter: 'text',   default: true },
    { key: 'title',        label: 'Title',        sort: 'text',   filter: 'text',   default: true },
    { key: 'email',        label: 'Email',        sort: 'text',   filter: 'text',   default: true },
    { key: 'phone',        label: 'Phone',        sort: 'text',   filter: 'text',   default: true },
    { key: 'mobile',       label: 'Mobile',       sort: 'text',   filter: 'text',   default: false },
    { key: 'is_primary',   label: 'Primary',      sort: 'text',   filter: 'select', default: true },
    { key: 'updated',      label: 'Updated',      sort: 'date',   filter: 'text',   default: true },
  ];

  const rowData = rows.map(r => ({
    id: r.id,
    account_id: r.account_id ?? '',
    first_name: r.first_name ?? '',
    last_name: r.last_name ?? '',
    account_name: r.account_name ?? '',
    title: r.title ?? '',
    email: r.email ?? '',
    phone: r.phone ?? '',
    mobile: r.mobile ?? '',
    // is_primary stored as string '0'/'1' so the inline-edit select and
    // the select-filter dropdown handle it uniformly; the patch handler
    // coerces back to 0/1 for storage.
    is_primary: r.is_primary === 1 ? '1' : '0',
    updated: (r.updated_at ?? '').slice(0, 10),
  }));

  const tabs = subnavTabs(
    [
      { href: '/accounts', label: 'Accounts' },
      { href: '/accounts/contacts', label: 'Contacts' },
    ],
    '/accounts/contacts'
  );

  const body = html`
    ${tabs}
    <section class="card">
      <div class="card-header">
        <h1 class="page-title">Contacts</h1>
        ${listToolbar({ id: 'contacts', count: rows.length, columns, bulk: true })}
      </div>

      ${rows.length === 0
        ? html`<p class="muted">
            No contacts yet. Open an account from the
            <a href="/accounts">Accounts</a> tab to add one.
          </p>`
        : html`
          <div class="opp-list" data-columns="${escape(JSON.stringify(columns))}">
            <table class="data opp-list-table">
              ${listTableHead(columns, rowData)}
              <tbody data-role="rows">
                ${rowData.map(r => html`
                  <tr data-row-id="${escape(r.id)}"
                      data-account_id="${escape(r.account_id)}"
                      ${raw(rowDataAttrs(columns, r))}>
                    <td class="col-open" data-col="open">
                      <a class="row-open-link" href="/contacts/${escape(r.id)}" title="Open contact" aria-label="Open contact">\u2197</a>
                    </td>
                    <td class="col-first_name" data-col="first_name">
                      ${ieText('first_name', r.first_name)}
                    </td>
                    <td class="col-last_name" data-col="last_name">
                      ${ieText('last_name', r.last_name)}
                    </td>
                    <td class="col-account_name" data-col="account_name">
                      ${r.account_id
                        ? html`<a href="/accounts/${escape(r.account_id)}">${escape(r.account_name)}</a>`
                        : html`<span class="muted">\u2014</span>`}
                    </td>
                    <td class="col-title" data-col="title">
                      ${ieText('title', r.title)}
                    </td>
                    <td class="col-email" data-col="email">
                      ${ieText('email', r.email, { inputType: 'email' })}
                    </td>
                    <td class="col-phone" data-col="phone">
                      ${ieText('phone', r.phone, { inputType: 'tel' })}
                    </td>
                    <td class="col-mobile" data-col="mobile">
                      ${ieText('mobile', r.mobile, { inputType: 'tel' })}
                    </td>
                    <td class="col-is_primary" data-col="is_primary">
                      ${ieSelect('is_primary', r.is_primary, PRIMARY_OPTIONS)}
                    </td>
                    <td class="col-updated" data-col="updated"><small class="muted">${escape(r.updated)}</small></td>
                  </tr>
                `)}
              </tbody>
            </table>
          </div>
          <script>${raw(listScript('pms.contacts.v1', 'last_name', 'asc'))}</script>
          <script>${raw(listInlineEditScript('/contacts/:id/patch'))}</script>
          <script>${raw(listBulkEditScript({
            patchUrl: '/contacts/:id/patch',
            deleteUrl: '/contacts/:id/delete',
          }))}</script>
        `}
    </section>
  `;

  return htmlResponse(
    layout('Contacts', body, {
      user,
      env: data?.env,
      activeNav: '/accounts',
      flash: readFlash(url),
      breadcrumbs: [{ label: 'Accounts', href: '/accounts' }, { label: 'Contacts' }],
    })
  );
}
