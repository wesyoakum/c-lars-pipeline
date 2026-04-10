// functions/accounts/[id]/contacts/new.js
//
// GET /accounts/:id/contacts/new — new-contact form (scoped to an account).
//
// POST target is /accounts/:id/contacts (handled by ./index.js onRequestPost).

import { one } from '../../../lib/db.js';
import { layout, htmlResponse, html, escape } from '../../../lib/layout.js';

export function renderNewContactForm(context, opts = {}) {
  const { data } = context;
  const user = data?.user;
  const account = opts.account;
  const values = opts.values ?? {};
  const errors = opts.errors ?? {};

  const body = html`
    <section class="card">
      <h1>New contact</h1>
      <p class="muted">
        Adding a contact to <a href="/accounts/${escape(account.id)}">${account.name}</a>.
      </p>

      <form method="post" action="/accounts/${escape(account.id)}/contacts" class="stacked">
        <div class="row">
          <label style="flex:1">
            <span>First name</span>
            <input type="text" name="first_name" value="${escape(values.first_name ?? '')}">
          </label>
          <label style="flex:1">
            <span>Last name</span>
            <input type="text" name="last_name" value="${escape(values.last_name ?? '')}">
          </label>
        </div>
        ${errors.name ? html`<small class="field-error">${errors.name}</small>` : ''}

        <label>
          <span>Title</span>
          <input type="text" name="title" value="${escape(values.title ?? '')}">
        </label>

        <label>
          <span>Email</span>
          <input type="email" name="email" value="${escape(values.email ?? '')}">
        </label>

        <div class="row">
          <label style="flex:1">
            <span>Phone</span>
            <input type="text" name="phone" value="${escape(values.phone ?? '')}">
          </label>
          <label style="flex:1">
            <span>Mobile</span>
            <input type="text" name="mobile" value="${escape(values.mobile ?? '')}">
          </label>
        </div>

        <label class="checkbox">
          <input type="checkbox" name="is_primary" value="1" ${values.is_primary ? 'checked' : ''}>
          <span>Primary contact for this account</span>
        </label>

        <div class="form-actions">
          <button type="submit" class="btn primary">Create contact</button>
          <a href="/accounts/${escape(account.id)}" class="btn">Cancel</a>
        </div>
      </form>
    </section>
  `;

  return htmlResponse(
    layout(`New contact — ${account.name}`, body, {
      user,
      env: data?.env,
      activeNav: '/accounts',
    }),
    { status: opts.errors ? 422 : 200 }
  );
}

export async function onRequestGet(context) {
  const { env, params } = context;
  const account = await one(
    env.DB,
    `SELECT id, name FROM accounts WHERE id = ?`,
    [params.id]
  );
  if (!account) {
    return htmlResponse(
      layout('Not found', '<section class="card"><h1>Account not found</h1></section>', {
        user: context.data?.user,
        env: context.data?.env,
        activeNav: '/accounts',
      }),
      { status: 404 }
    );
  }
  return renderNewContactForm(context, { account });
}
