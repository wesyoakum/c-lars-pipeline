// functions/accounts/[id]/edit.js
//
// GET /accounts/:id/edit — edit-account form.
//
// POST target is /accounts/:id (handled by ./index.js onRequestPost).
// That handler re-renders this form via renderEditForm() on validation failure.

import { one, all } from '../../lib/db.js';
import { layout, htmlResponse, html, raw, escape } from '../../lib/layout.js';
import { readFlash } from '../../lib/http.js';
import { loadAddresses, renderAddressEditor, addressEditorScript } from '../../lib/address_editor.js';

const SEGMENTS = ['WROV', 'Research', 'Defense', 'Commercial', 'Other'];

export async function renderEditForm(context, opts = {}) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const account = opts.account;
  const errors = opts.errors ?? {};
  // opts.addresses takes precedence (re-render path, user edits in progress);
  // otherwise use the DB-loaded list passed in by the GET handler.
  const addresses = opts.addresses ?? account.addresses ?? [];

  const users = await all(
    env.DB,
    `SELECT id, display_name, email FROM users WHERE active = 1 ORDER BY display_name`
  );

  const body = html`
    <section class="card">
      <h1>Edit account</h1>

      <form method="post" action="/accounts/${escape(account.id)}" class="stacked">
        <label>
          <span>Name <em>*</em></span>
          <input type="text" name="name" required value="${escape(account.name ?? '')}">
          ${errors.name ? html`<small class="field-error">${errors.name}</small>` : ''}
        </label>

        <label>
          <span>Segment</span>
          <select name="segment">
            <option value="">— Select —</option>
            ${SEGMENTS.map(
              (s) => html`<option value="${s}" ${account.segment === s ? 'selected' : ''}>${s}</option>`
            )}
          </select>
        </label>

        <label>
          <span>Phone</span>
          <input type="text" name="phone" value="${escape(account.phone ?? '')}">
        </label>

        <label>
          <span>Website</span>
          <input type="text" name="website" value="${escape(account.website ?? '')}">
        </label>

        ${renderAddressEditor(addresses)}

        <label>
          <span>Owner</span>
          <select name="owner_user_id">
            <option value="">— None —</option>
            ${users.map(
              (u) => html`<option value="${escape(u.id)}" ${account.owner_user_id === u.id ? 'selected' : ''}>${u.display_name ?? u.email}</option>`
            )}
          </select>
        </label>

        <label>
          <span>Notes</span>
          <textarea name="notes" rows="4">${escape(account.notes ?? '')}</textarea>
        </label>

        <div class="form-actions">
          <button type="submit" class="btn primary">Save changes</button>
          <a href="/accounts/${escape(account.id)}" class="btn">Cancel</a>
        </div>
      </form>
    </section>
    <script>${raw(addressEditorScript())}</script>
  `;

  return htmlResponse(
    layout(`Edit ${account.name}`, body, {
      user,
      env: data?.env,
      activeNav: '/accounts',
      flash: readFlash(url),
      breadcrumbs: [
        { label: 'Accounts', href: '/accounts' },
        { label: escape(account.name), href: '/accounts/' + escape(account.id) },
        { label: 'Edit' },
      ],
    }),
    { status: opts.errors ? 422 : 200 }
  );
}

export async function onRequestGet(context) {
  const { env, params } = context;
  const account = await one(
    env.DB,
    `SELECT * FROM accounts WHERE id = ?`,
    [params.id]
  );
  if (!account) {
    return htmlResponse(
      layout('Account not found', `<section class="card"><h1>Account not found</h1><p><a href="/accounts">Back to accounts</a></p></section>`, {
        user: context.data?.user,
        env: context.data?.env,
        activeNav: '/accounts',
      }),
      { status: 404 }
    );
  }
  const addresses = await loadAddresses(env.DB, params.id);
  return renderEditForm(context, { account: { ...account, addresses } });
}
