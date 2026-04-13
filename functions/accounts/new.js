// functions/accounts/new.js
//
// GET /accounts/new — create-account form.
//
// The POST target for this form is /accounts (handled by accounts/index.js),
// which will re-render this page with inline errors on validation failure
// by importing renderNewForm() below.
//
// Also supports popup mode (?popup=1). When the user opens this form from
// the opportunity form via the "+ New account" button we open it in a
// popup window; on successful create the opener gets a postMessage with
// the new account's id + name and the popup auto-closes.

import { all } from '../lib/db.js';
import { layout, htmlResponse, html, raw, escape } from '../lib/layout.js';
import { readFlash, isPopupMode } from '../lib/http.js';
import { renderAddressEditor, addressEditorScript } from '../lib/address_editor.js';

const SEGMENTS = ['WROV', 'Research', 'Defense', 'Commercial', 'Other'];

export async function renderNewForm(context, opts = {}) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const values = opts.values ?? {};
  const errors = opts.errors ?? {};
  const popup = isPopupMode(request, values);

  // On validation re-render we need to echo back whatever addresses the
  // user had entered. opts.addresses (supplied by the POST handler on
  // failure) wins over values.addresses_json so the user doesn't lose work.
  const initialAddresses = opts.addresses ?? [];

  const users = await all(
    env.DB,
    `SELECT id, display_name, email FROM users WHERE active = 1 ORDER BY display_name`
  );
  const selectedOwner = values.owner_user_id ?? user?.id ?? '';

  const body = html`
    <section class="card">
      <h1>New account</h1>
      <p class="muted">
        Accounts are the organizations C-LARS quotes and sells to. A contact
        must be attached after creation.
      </p>

      <form method="post" action="/accounts${popup ? '?popup=1' : ''}" class="stacked">
        ${popup ? html`<input type="hidden" name="popup" value="1">` : ''}
        <label>
          <span>Name <em>*</em></span>
          <input type="text" name="name" required value="${escape(values.name ?? '')}">
          ${errors.name ? html`<small class="field-error">${errors.name}</small>` : ''}
        </label>

        <label>
          <span>Segment</span>
          <select name="segment">
            <option value="">— Select —</option>
            ${SEGMENTS.map(
              (s) => html`<option value="${s}" ${values.segment === s ? 'selected' : ''}>${s}</option>`
            )}
          </select>
        </label>

        <label>
          <span>Phone</span>
          <input type="text" name="phone" value="${escape(values.phone ?? '')}">
        </label>

        <label>
          <span>Website</span>
          <input type="text" name="website" value="${escape(values.website ?? '')}"
                 placeholder="https://example.com">
        </label>

        ${renderAddressEditor(initialAddresses)}

        <label>
          <span>Owner</span>
          <select name="owner_user_id">
            <option value="">— None —</option>
            ${users.map(
              (u) => html`<option value="${escape(u.id)}" ${selectedOwner === u.id ? 'selected' : ''}>${u.display_name ?? u.email}</option>`
            )}
          </select>
        </label>

        <label>
          <span>Notes</span>
          <textarea name="notes" rows="4">${escape(values.notes ?? '')}</textarea>
        </label>

        <div class="form-actions">
          <button type="submit" class="btn primary">Create account</button>
          ${popup
            ? html`<button type="button" class="btn" onclick="window.close()">Cancel</button>`
            : html`<a href="/accounts" class="btn">Cancel</a>`}
        </div>
      </form>
    </section>
    <script>${raw(addressEditorScript())}</script>
  `;

  return htmlResponse(
    layout('New account', body, {
      user,
      env: data?.env, commitSha: data?.commitSha,
      activeNav: '/accounts',
      flash: readFlash(url),
    }),
    {
      // If we're re-rendering due to errors, return 422 so the browser
      // history doesn't treat this as a fresh success.
      status: opts.errors ? 422 : 200,
    }
  );
}

export async function onRequestGet(context) {
  return renderNewForm(context);
}
