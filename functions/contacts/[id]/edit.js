// functions/contacts/[id]/edit.js
//
// GET /contacts/:id/edit — edit-contact form.
//
// POST target is /contacts/:id (handled by ./index.js onRequestPost).
// That handler re-renders this form via renderEditForm() on validation
// failure. Per the "everything except UUID is editable" rule, this form
// covers every business field on a contact: account (so a contact can
// be moved between accounts), name, title, email, phone, mobile,
// is_primary, and notes.

import { one, all } from '../../lib/db.js';
import { layout, htmlResponse, html, escape } from '../../lib/layout.js';
import { readFlash } from '../../lib/http.js';

export async function renderEditForm(context, opts = {}) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const contact = opts.contact;
  const errors = opts.errors ?? {};

  const accounts = await all(env.DB, 'SELECT id, name FROM accounts ORDER BY name');

  const displayName =
    [contact.first_name, contact.last_name].filter(Boolean).join(' ') || '(no name)';

  const body = html`
    <section class="card">
      <div class="card-header">
        <div>
          <h1>Edit contact</h1>
          <p class="muted">${escape(displayName)}</p>
        </div>
        <div class="header-actions">
          <a class="btn" href="/accounts/${escape(contact.account_id)}">Cancel</a>
        </div>
      </div>

      <form method="post" action="/contacts/${escape(contact.id)}" class="stacked">
        <label>
          <span>Account <em>*</em></span>
          <select name="account_id" required>
            <option value="">— Select account —</option>
            ${accounts.map(
              (a) => html`<option value="${escape(a.id)}" ${contact.account_id === a.id ? 'selected' : ''}>${a.name}</option>`
            )}
          </select>
          ${errors.account_id ? html`<small class="field-error">${errors.account_id}</small>` : ''}
          <small class="muted">Changing the account moves this contact.</small>
        </label>

        <div class="row">
          <label style="flex:1">
            <span>First name</span>
            <input type="text" name="first_name" value="${escape(contact.first_name ?? '')}">
          </label>
          <label style="flex:1">
            <span>Last name</span>
            <input type="text" name="last_name" value="${escape(contact.last_name ?? '')}">
          </label>
        </div>
        ${errors.name ? html`<small class="field-error">${errors.name}</small>` : ''}

        <label>
          <span>Title</span>
          <input type="text" name="title" value="${escape(contact.title ?? '')}">
        </label>

        <label>
          <span>Email</span>
          <input type="email" name="email" value="${escape(contact.email ?? '')}">
        </label>

        <div class="row">
          <label style="flex:1">
            <span>Phone</span>
            <input type="text" name="phone" value="${escape(contact.phone ?? '')}">
          </label>
          <label style="flex:1">
            <span>Mobile</span>
            <input type="text" name="mobile" value="${escape(contact.mobile ?? '')}">
          </label>
        </div>

        <label class="checkbox">
          <input type="checkbox" name="is_primary" value="1" ${contact.is_primary ? 'checked' : ''}>
          <span>Primary contact for this account</span>
        </label>

        <label>
          <span>Notes</span>
          <textarea name="notes" rows="4">${escape(contact.notes ?? '')}</textarea>
        </label>

        <div class="form-actions">
          <button type="submit" class="btn primary">Save changes</button>
          <a href="/accounts/${escape(contact.account_id)}" class="btn">Cancel</a>
        </div>
      </form>
    </section>
  `;

  return htmlResponse(
    layout(`Edit ${displayName}`, body, {
      user,
      env: data?.env,
      activeNav: '/accounts',
      flash: readFlash(url),
    }),
    { status: opts.errors ? 422 : 200 }
  );
}

export async function onRequestGet(context) {
  const { env, params } = context;
  const contact = await one(
    env.DB,
    `SELECT * FROM contacts WHERE id = ?`,
    [params.id]
  );
  if (!contact) {
    return htmlResponse(
      layout(
        'Contact not found',
        `<section class="card">
          <h1>Contact not found</h1>
          <p><a href="/accounts">Back to accounts</a></p>
        </section>`,
        {
          user: context.data?.user,
          env: context.data?.env,
          activeNav: '/accounts',
        }
      ),
      { status: 404 }
    );
  }
  return renderEditForm(context, { contact });
}
