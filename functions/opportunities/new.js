// functions/opportunities/new.js
//
// GET /opportunities/new — new-opportunity form.
//
// POST target is /opportunities (opportunities/index.js onRequestPost),
// which will re-render this page with inline errors on validation failure
// by importing renderNewForm() below.

import { all } from '../lib/db.js';
import { layout, htmlResponse, html, escape } from '../lib/layout.js';
import { readFlash } from '../lib/http.js';

const TYPE_OPTIONS = [
  { value: 'spares', label: 'Spares' },
  { value: 'eps', label: 'Engineered Product (EPS)' },
  { value: 'refurb', label: 'Refurbishment' },
  { value: 'service', label: 'Service' },
];

// Human labels for the rfq_format enum. These mirror the validator's
// RFQ_FORMATS set — keep them in sync if you add new values.
const RFQ_FORMAT_OPTIONS = [
  { value: '', label: '— Not specified —' },
  { value: 'verbal', label: 'Verbal (phone / in-person)' },
  { value: 'text', label: 'Text message' },
  { value: 'email_informal', label: 'Email — informal' },
  { value: 'email_formal', label: 'Email — formal' },
  { value: 'formal_document', label: 'Formal RFQ document' },
  { value: 'government_rfq', label: 'Government RFQ' },
  { value: 'rfi_preliminary', label: 'RFI / preliminary inquiry' },
  { value: 'none', label: 'None (proactive outreach)' },
  { value: 'other', label: 'Other' },
];

const BANT_BUDGET_OPTIONS = [
  { value: '', label: '— Unknown —' },
  { value: 'known', label: 'Known' },
  { value: 'estimated', label: 'Estimated' },
  { value: 'unknown', label: 'Unknown' },
];

export async function renderNewForm(context, opts = {}) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const values = opts.values ?? {};
  const errors = opts.errors ?? {};

  // Accounts dropdown. In P0 we load the whole list (solo-user system,
  // never going to be huge). Later this could become an HTMX autocomplete.
  const accounts = await all(env.DB, 'SELECT id, name FROM accounts ORDER BY name');

  // Allow ?account=<id> to preselect (e.g. "new opp" link from an account page).
  const preselectAccount = values.account_id ?? url.searchParams.get('account') ?? '';

  const body = html`
    <section class="card">
      <h1>New opportunity</h1>
      <p class="muted">
        An opportunity is the spine of a deal. Cost builds, quotes,
        documents, and the Job handoff all hang off it.
      </p>

      <form method="post" action="/opportunities" class="stacked">
        <label>
          <span>Title <em>*</em></span>
          <input type="text" name="title" required value="${escape(values.title ?? '')}"
                 placeholder="e.g. LARS-200 refurb for Acme Subsea">
          ${errors.title ? html`<small class="field-error">${errors.title}</small>` : ''}
        </label>

        <div class="row">
          <label style="flex:1">
            <span>Account <em>*</em></span>
            <select name="account_id" required>
              <option value="">— Select account —</option>
              ${accounts.map(
                (a) =>
                  html`<option value="${escape(a.id)}" ${preselectAccount === a.id ? 'selected' : ''}>${a.name}</option>`
              )}
            </select>
            ${errors.account_id ? html`<small class="field-error">${errors.account_id}</small>` : ''}
          </label>

          <label style="flex:1">
            <span>Transaction type <em>*</em></span>
            <select name="transaction_type" required>
              <option value="">— Select type —</option>
              ${TYPE_OPTIONS.map(
                (t) =>
                  html`<option value="${t.value}" ${values.transaction_type === t.value ? 'selected' : ''}>${t.label}</option>`
              )}
            </select>
            ${errors.transaction_type ? html`<small class="field-error">${errors.transaction_type}</small>` : ''}
          </label>
        </div>

        <label>
          <span>Description</span>
          <textarea name="description" rows="4"
                    placeholder="Short summary of what the customer is asking for.">${escape(values.description ?? '')}</textarea>
        </label>

        <label>
          <span>How did the RFQ arrive?</span>
          <select name="rfq_format">
            ${RFQ_FORMAT_OPTIONS.map(
              (o) =>
                html`<option value="${o.value}" ${(values.rfq_format ?? '') === o.value ? 'selected' : ''}>${o.label}</option>`
            )}
          </select>
          ${errors.rfq_format ? html`<small class="field-error">${errors.rfq_format}</small>` : ''}
        </label>

        <div class="row">
          <label style="flex:1">
            <span>Estimated value (USD)</span>
            <input type="number" name="estimated_value_usd" min="0" step="1"
                   value="${escape(values.estimated_value_usd ?? '')}">
            ${errors.estimated_value_usd ? html`<small class="field-error">${errors.estimated_value_usd}</small>` : ''}
          </label>
          <label style="flex:1">
            <span>Expected close date</span>
            <input type="date" name="expected_close_date"
                   value="${escape(values.expected_close_date ?? '')}">
            ${errors.expected_close_date ? html`<small class="field-error">${errors.expected_close_date}</small>` : ''}
          </label>
        </div>

        <fieldset style="border:1px solid var(--border); border-radius: var(--radius); padding: 0.75rem 1rem;">
          <legend style="font-size: 0.85rem; color: var(--fg-muted);">BANT-lite</legend>
          <div class="row">
            <label style="flex:1">
              <span>Budget</span>
              <select name="bant_budget">
                ${BANT_BUDGET_OPTIONS.map(
                  (o) =>
                    html`<option value="${o.value}" ${(values.bant_budget ?? '') === o.value ? 'selected' : ''}>${o.label}</option>`
                )}
              </select>
            </label>
            <label style="flex:1">
              <span>Authority</span>
              <input type="text" name="bant_authority" value="${escape(values.bant_authority ?? '')}"
                     placeholder="Who signs the PO?">
            </label>
          </div>
          <div class="row">
            <label style="flex:1">
              <span>Need</span>
              <input type="text" name="bant_need" value="${escape(values.bant_need ?? '')}"
                     placeholder="Why now?">
            </label>
            <label style="flex:1">
              <span>Timeline</span>
              <input type="text" name="bant_timeline" value="${escape(values.bant_timeline ?? '')}"
                     placeholder="e.g. Q3 2026 delivery">
            </label>
          </div>
        </fieldset>

        <div class="form-actions">
          <button type="submit" class="btn primary">Create opportunity</button>
          <a href="/opportunities" class="btn">Cancel</a>
        </div>
      </form>
    </section>
  `;

  return htmlResponse(
    layout('New opportunity', body, {
      user,
      env: data?.env,
      activeNav: '/opportunities',
      flash: readFlash(url),
    }),
    { status: opts.errors ? 422 : 200 }
  );
}

export async function onRequestGet(context) {
  return renderNewForm(context);
}
