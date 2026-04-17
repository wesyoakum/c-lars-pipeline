// functions/settings/users.js
//
// GET /settings/users — admin-only list of app users with inline-edit
// role + active toggle. No create flow here (users are provisioned by
// signing in via Cloudflare Access); admins can just adjust role /
// deactivate existing rows.
//
// Inline edits POST to /settings/users/:id/patch which lives alongside
// this file under /settings/users/[id]/patch.js.

import { all } from '../lib/db.js';
import { layout, htmlResponse, html, escape, raw } from '../lib/layout.js';
import { readFlash } from '../lib/http.js';
import { hasRole } from '../lib/auth.js';
import { listScript, listTableHead, listToolbar, rowDataAttrs } from '../lib/list-table.js';
import { ieSelect, listInlineEditScript } from '../lib/list-inline-edit.js';

// String-valued options for the inline-edit select so the patch
// handler can accept them verbatim. `active`/`inactive` round-trip to
// the 0/1 integer in the DB.
const ROLE_OPTIONS = [
  { value: 'admin',   label: 'Admin' },
  { value: 'sales',   label: 'Sales' },
  { value: 'service', label: 'Service' },
  { value: 'viewer',  label: 'Viewer' },
];

const ACTIVE_OPTIONS = [
  { value: 'active',   label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);

  if (!hasRole(user, 'admin')) {
    return htmlResponse(
      layout('Users', `
        <section class="card">
          <h1>Users</h1>
          <p>Admin role required to view this page.</p>
        </section>`,
        { user, env: data?.env, activeNav: '/settings' }),
      { status: 403 }
    );
  }

  const rows = await all(
    env.DB,
    `SELECT id, email, display_name, role, active, created_at, updated_at
       FROM users
      ORDER BY active DESC, email ASC`
  );

  const columns = [
    { key: 'email',        label: 'Email',       sort: 'text',   filter: 'text',   default: true  },
    { key: 'display_name', label: 'Name',        sort: 'text',   filter: 'text',   default: true  },
    { key: 'role',         label: 'Role',        sort: 'text',   filter: 'select', default: true  },
    { key: 'status',       label: 'Status',      sort: 'text',   filter: 'select', default: true  },
    { key: 'created',      label: 'Created',     sort: 'date',   filter: 'text',   default: true  },
    { key: 'updated',      label: 'Updated',     sort: 'date',   filter: 'text',   default: false },
  ];

  const rowData = rows.map((r) => ({
    id: r.id,
    email: r.email ?? '',
    display_name: r.display_name ?? '',
    role: r.role ?? 'sales',
    status: r.active ? 'active' : 'inactive',
    active: r.active,
    created: (r.created_at ?? '').slice(0, 10),
    updated: (r.updated_at ?? '').slice(0, 10),
  }));

  const body = html`
    <section class="card">
      <div class="card-header">
        <h1>Users</h1>
        <div style="display:flex;align-items:center;gap:0.5rem">
          ${listToolbar({ id: 'users', count: rows.length, columns })}
          <a class="btn" href="/settings">\u2190 Settings</a>
        </div>
      </div>

      <p class="muted">
        One row per person who has signed in. New users provision
        automatically via Cloudflare Access on first sign-in; adjust
        their role or mark them inactive here.
      </p>

      ${rows.length === 0
        ? html`<p class="muted">No users yet.</p>`
        : html`
          <div class="opp-list" data-columns="${escape(JSON.stringify(columns))}">
            <table class="data opp-list-table">
              ${listTableHead(columns, rowData)}
              <tbody data-role="rows">
                ${rowData.map((r) => html`
                  <tr data-row-id="${escape(r.id)}"
                      ${raw(rowDataAttrs(columns, r))}
                      ${!r.active ? raw('class="inactive"') : ''}>
                    <td class="col-email" data-col="email">${escape(r.email)}</td>
                    <td class="col-display_name" data-col="display_name">${escape(r.display_name)}</td>
                    <td class="col-role" data-col="role">
                      ${ieSelect('role', r.role, ROLE_OPTIONS)}
                    </td>
                    <td class="col-status" data-col="status">
                      ${ieSelect('is_active', r.status, ACTIVE_OPTIONS)}
                    </td>
                    <td class="col-created" data-col="created"><small class="muted">${escape(r.created)}</small></td>
                    <td class="col-updated" data-col="updated"><small class="muted">${escape(r.updated)}</small></td>
                  </tr>
                `)}
              </tbody>
            </table>
          </div>
          <script>${raw(listScript('pms.usersList.v1', 'email', 'asc'))}</script>
          <script>${raw(listInlineEditScript('/settings/users/:id/patch', {
            // Column key `status` \u2194 patch field `is_active`. Patch handler
            // accepts 'active'/'inactive' strings and coerces to 0/1.
            fieldAttrMap: { is_active: 'status' },
          }))}</script>
        `}
    </section>
  `;

  return htmlResponse(
    layout('Users', body, {
      user,
      env: data?.env,
      activeNav: '/settings',
      flash: readFlash(url),
      breadcrumbs: [
        { label: 'Settings', href: '/settings' },
        { label: 'Users' },
      ],
    })
  );
}
