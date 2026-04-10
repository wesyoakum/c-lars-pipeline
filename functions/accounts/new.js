// functions/accounts/new.js
//
// GET /accounts/new — create-account form.
//
// The POST target for this form is /accounts (handled by accounts/index.js),
// which will re-render this page with inline errors on validation failure
// by importing renderNewForm() below.

import { layout, htmlResponse, html, escape } from '../lib/layout.js';
import { readFlash } from '../lib/http.js';

const SEGMENTS = ['WROV', 'Research', 'Defense', 'Commercial', 'Other'];

export function renderNewForm(context, opts = {}) {
  const { data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const values = opts.values ?? {};
  const errors = opts.errors ?? {};

  const body = html`
    <section class="card">
      <h1>New account</h1>
      <p class="muted">
        Accounts are the organizations C-LARS quotes and sells to. A contact
        must be attached after creation.
      </p>

      <form method="post" action="/accounts" class="stacked">
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

        <label>
          <span>Billing address</span>
          <textarea name="address_billing" rows="3">${escape(values.address_billing ?? '')}</textarea>
        </label>

        <label>
          <span>Physical address (if different)</span>
          <textarea name="address_physical" rows="3">${escape(values.address_physical ?? '')}</textarea>
        </label>

        <label>
          <span>Notes</span>
          <textarea name="notes" rows="4">${escape(values.notes ?? '')}</textarea>
        </label>

        <div class="form-actions">
          <button type="submit" class="btn primary">Create account</button>
          <a href="/accounts" class="btn">Cancel</a>
        </div>
      </form>
    </section>
  `;

  return htmlResponse(
    layout('New account', body, {
      user,
      env: data?.env,
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
