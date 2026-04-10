// functions/accounts/[id]/edit.js
//
// GET /accounts/:id/edit — edit-account form.
//
// POST target is /accounts/:id (handled by ./index.js onRequestPost).
// That handler re-renders this form via renderEditForm() on validation failure.

import { one } from '../../lib/db.js';
import { layout, htmlResponse, html, escape } from '../../lib/layout.js';
import { readFlash } from '../../lib/http.js';

const SEGMENTS = ['WROV', 'Research', 'Defense', 'Commercial', 'Other'];

export function renderEditForm(context, opts = {}) {
  const { data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const account = opts.account;
  const errors = opts.errors ?? {};

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

        <label>
          <span>Billing address</span>
          <textarea name="address_billing" rows="3">${escape(account.address_billing ?? '')}</textarea>
        </label>

        <label>
          <span>Physical address (if different)</span>
          <textarea name="address_physical" rows="3">${escape(account.address_physical ?? '')}</textarea>
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
  `;

  return htmlResponse(
    layout(`Edit ${account.name}`, body, {
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
  return renderEditForm(context, { account });
}
