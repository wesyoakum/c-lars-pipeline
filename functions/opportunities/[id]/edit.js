// functions/opportunities/[id]/edit.js
//
// GET /opportunities/:id/edit — edit form.
//
// POST target is /opportunities/:id (index.js onRequestPost), which
// will re-render this page with inline errors on validation failure
// by importing renderEditForm() below.

import { one, all } from '../../lib/db.js';
import { layout, htmlResponse, html, raw, escape } from '../../lib/layout.js';
import { readFlash } from '../../lib/http.js';
import { oppPickerScript, typePickerScript } from '../new.js';
import { parseTransactionTypes } from '../../lib/validators.js';

const TYPE_OPTIONS = [
  { value: 'spares', label: 'Spares' },
  { value: 'eps', label: 'Engineered Product (EPS)' },
  { value: 'refurb', label: 'Refurbishment' },
  { value: 'service', label: 'Service' },
];

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

const SOURCE_OPTIONS = [
  { value: '', label: '— Not specified —' },
  { value: 'inbound', label: 'Inbound (customer reached out)' },
  { value: 'outreach', label: 'Outreach (we reached out)' },
  { value: 'referral', label: 'Referral' },
  { value: 'existing', label: 'Existing customer follow-on' },
  { value: 'other', label: 'Other' },
];

const BANT_BUDGET_OPTIONS = [
  { value: '', label: '— Unknown —' },
  { value: 'known', label: 'Known' },
  { value: 'estimated', label: 'Estimated' },
  { value: 'unknown', label: 'Unknown' },
];

export async function renderEditForm(context, opts = {}) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const opp = opts.opportunity;
  const errors = opts.errors ?? {};

  // Accounts, contacts (for primary-contact picker scoped to current account),
  // and users (for owner/salesperson).
  const [accounts, contacts, users] = await Promise.all([
    all(env.DB, 'SELECT id, name FROM accounts ORDER BY name'),
    all(
      env.DB,
      `SELECT id, first_name, last_name, title FROM contacts WHERE account_id = ?
        ORDER BY is_primary DESC, last_name, first_name`,
      [opp.account_id]
    ),
    all(
      env.DB,
      `SELECT id, display_name, email FROM users WHERE active = 1 ORDER BY display_name`
    ),
  ]);

  const body = html`
    <section class="card">
      <div class="card-header">
        <div>
          <h1>Edit ${escape(opp.number ?? 'opportunity')}</h1>
          <p class="muted">${escape(opp.title ?? '')}</p>
        </div>
        <div class="header-actions">
          <a class="btn" href="/opportunities/${escape(opp.id)}">Cancel</a>
        </div>
      </div>

      <form method="post" action="/opportunities/${escape(opp.id)}" class="stacked opp-form"
            data-initial-account="${escape(opp.account_id ?? '')}">
        <div class="row">
          <label style="flex:2">
            <span>Title <em>*</em></span>
            <input type="text" name="title" required value="${escape(opp.title ?? '')}">
            ${errors.title ? html`<small class="field-error">${errors.title}</small>` : ''}
          </label>
          <label style="flex:1">
            <span>Number</span>
            <input type="text" name="number" inputmode="numeric"
                   value="${escape(opp.number ?? '')}">
            ${errors.number ? html`<small class="field-error">${errors.number}</small>` : ''}
            <small class="muted">Editable; must be unique.</small>
          </label>
        </div>

        <div class="row">
          <label style="flex:1">
            <span>Account <em>*</em></span>
            <select name="account_id" required data-role="account-select">
              <option value="">— Select account —</option>
              ${accounts.map(
                (a) =>
                  html`<option value="${escape(a.id)}" ${opp.account_id === a.id ? 'selected' : ''}>${a.name}</option>`
              )}
              <option value="__new__">+ Add new account</option>
            </select>
            ${errors.account_id ? html`<small class="field-error">${errors.account_id}</small>` : ''}
          </label>

          <fieldset style="flex:1;border:none;padding:0;margin:0">
            <span>Type(s) <em>*</em></span>
            <input type="hidden" name="transaction_type" id="tt-hidden" value="${escape(opp.transaction_type ?? '')}">
            <div class="checkbox-row" x-data="typePicker('${escape(opp.transaction_type ?? '')}')">
              ${TYPE_OPTIONS.map(
                (t) =>
                  html`<label class="check-label">
                    <input type="checkbox" value="${t.value}" :checked="types.includes('${t.value}')" @change="toggle('${t.value}', $event.target.checked)">
                    ${t.label}
                  </label>`
              )}
            </div>
            ${errors.transaction_type ? html`<small class="field-error">${errors.transaction_type}</small>` : ''}
          </fieldset>
        </div>

        <label>
          <span>Primary contact</span>
          <div class="picker-row">
            <select name="primary_contact_id" data-role="primary-contact-select">
              <option value="">— None —</option>
              ${contacts.map((c) => {
                const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || '(no name)';
                return html`<option value="${escape(c.id)}" ${opp.primary_contact_id === c.id ? 'selected' : ''}>${name}</option>`;
              })}
            </select>
            <button type="button" class="btn btn-sm" data-action="new-contact" data-target="primary-contact-select">+ New contact</button>
          </div>
        </label>

        <label>
          <span>Description</span>
          <textarea name="description" rows="4">${escape(opp.description ?? '')}</textarea>
        </label>

        <div class="row">
          <label style="flex:1">
            <span>How did the RFQ arrive?</span>
            <select name="rfq_format">
              ${RFQ_FORMAT_OPTIONS.map(
                (o) =>
                  html`<option value="${o.value}" ${(opp.rfq_format ?? '') === o.value ? 'selected' : ''}>${o.label}</option>`
              )}
            </select>
            ${errors.rfq_format ? html`<small class="field-error">${errors.rfq_format}</small>` : ''}
          </label>
          <label style="flex:1">
            <span>Source</span>
            <select name="source">
              ${SOURCE_OPTIONS.map(
                (o) =>
                  html`<option value="${o.value}" ${(opp.source ?? '') === o.value ? 'selected' : ''}>${o.label}</option>`
              )}
            </select>
            ${errors.source ? html`<small class="field-error">${errors.source}</small>` : ''}
          </label>
        </div>

        <div class="row">
          <label style="flex:1">
            <span>Estimated value (USD)</span>
            <input type="number" name="estimated_value_usd" min="0" step="1"
                   value="${escape(opp.estimated_value_usd ?? '')}">
            ${errors.estimated_value_usd ? html`<small class="field-error">${errors.estimated_value_usd}</small>` : ''}
          </label>
          <label style="flex:1">
            <span>Probability (%)</span>
            <input type="number" name="probability" min="0" max="100" step="1"
                   value="${escape(opp.probability ?? '')}"
                   placeholder="defaults from stage">
            ${errors.probability ? html`<small class="field-error">${errors.probability}</small>` : ''}
          </label>
        </div>

        <fieldset class="qualification-box">
          <legend>Pipeline dates</legend>
          <div class="row">
            <label style="flex:1">
              <span>RFQ received</span>
              <input type="date" name="rfq_received_date"
                     value="${escape(opp.rfq_received_date ?? '')}">
              ${errors.rfq_received_date ? html`<small class="field-error">${errors.rfq_received_date}</small>` : ''}
            </label>
            <label style="flex:1">
              <span>RFQ due</span>
              <input type="date" name="rfq_due_date"
                     value="${escape(opp.rfq_due_date ?? '')}">
              ${errors.rfq_due_date ? html`<small class="field-error">${errors.rfq_due_date}</small>` : ''}
            </label>
          </div>
          <div class="row">
            <label style="flex:1">
              <span>RFI due</span>
              <input type="date" name="rfi_due_date"
                     value="${escape(opp.rfi_due_date ?? '')}">
              ${errors.rfi_due_date ? html`<small class="field-error">${errors.rfi_due_date}</small>` : ''}
            </label>
            <label style="flex:1">
              <span>Quoted</span>
              <input type="date" name="quoted_date"
                     value="${escape(opp.quoted_date ?? '')}">
              ${errors.quoted_date ? html`<small class="field-error">${errors.quoted_date}</small>` : ''}
            </label>
          </div>
          <div class="row">
            <label style="flex:1">
              <span>Expected close</span>
              <input type="date" name="expected_close_date"
                     value="${escape(opp.expected_close_date ?? '')}">
              ${errors.expected_close_date ? html`<small class="field-error">${errors.expected_close_date}</small>` : ''}
            </label>
            <div style="flex:1"></div>
          </div>
        </fieldset>

        <div class="row">
          <label style="flex:1">
            <span>Owner</span>
            <select name="owner_user_id">
              <option value="">— None —</option>
              ${users.map(
                (u) =>
                  html`<option value="${escape(u.id)}" ${opp.owner_user_id === u.id ? 'selected' : ''}>${u.display_name ?? u.email}</option>`
              )}
            </select>
          </label>
          <label style="flex:1">
            <span>Salesperson</span>
            <select name="salesperson_user_id">
              <option value="">— None —</option>
              ${users.map(
                (u) =>
                  html`<option value="${escape(u.id)}" ${opp.salesperson_user_id === u.id ? 'selected' : ''}>${u.display_name ?? u.email}</option>`
              )}
            </select>
          </label>
        </div>

        <div class="row">
          <label style="flex:1">
            <span>Customer PO number</span>
            <input type="text" name="customer_po_number"
                   value="${escape(opp.customer_po_number ?? '')}"
                   placeholder="PO-12345 (required for Closed Won)">
          </label>
          <div style="flex:1"></div>
        </div>

        <fieldset class="qualification-box">
          <legend>Qualification</legend>
          <div class="row">
            <label style="flex:1">
              <span>Budget</span>
              <select name="bant_budget">
                ${BANT_BUDGET_OPTIONS.map(
                  (o) =>
                    html`<option value="${o.value}" ${(opp.bant_budget ?? '') === o.value ? 'selected' : ''}>${o.label}</option>`
                )}
              </select>
            </label>
            <label style="flex:1">
              <span>Authority (contact)</span>
              <div class="picker-row">
                <select name="bant_authority_contact_id" data-role="authority-select">
                  <option value="">— None —</option>
                  ${contacts.map((c) => {
                    const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || '(no name)';
                    const titleSuffix = c.title ? ` — ${c.title}` : '';
                    return html`<option value="${escape(c.id)}" ${opp.bant_authority_contact_id === c.id ? 'selected' : ''}>${name}${titleSuffix}</option>`;
                  })}
                </select>
                <button type="button" class="btn btn-sm" data-action="new-contact" data-target="authority-select">+ New contact</button>
              </div>
              <input type="hidden" name="bant_authority" value="${escape(opp.bant_authority ?? '')}">
            </label>
          </div>
          <div class="row">
            <label style="flex:1">
              <span>Need</span>
              <input type="text" name="bant_need" value="${escape(opp.bant_need ?? '')}">
            </label>
            <label style="flex:1">
              <span>Timeline</span>
              <input type="text" name="bant_timeline" value="${escape(opp.bant_timeline ?? '')}">
            </label>
          </div>
        </fieldset>

        <div class="form-actions">
          <button type="submit" class="btn primary">Save changes</button>
          <a href="/opportunities/${escape(opp.id)}" class="btn">Cancel</a>
        </div>
      </form>
    </section>

    <script>${raw(oppPickerScript())}
${raw(typePickerScript())}</script>
  `;

  return htmlResponse(
    layout(`Edit ${opp.number ?? 'opportunity'}`, body, {
      user,
      env: data?.env,
      activeNav: '/opportunities',
      flash: readFlash(url),
      breadcrumbs: [
        { label: 'Opportunities', href: '/opportunities' },
        { label: escape(opp.number ?? 'opportunity'), href: '/opportunities/' + escape(opp.id) },
        { label: 'Edit' },
      ],
    }),
    { status: opts.errors ? 422 : 200 }
  );
}

export async function onRequestGet(context) {
  const { env, params } = context;
  const opp = await one(
    env.DB,
    `SELECT * FROM opportunities WHERE id = ?`,
    [params.id]
  );
  if (!opp) {
    return htmlResponse(
      layout(
        'Opportunity not found',
        `<section class="card">
          <h1>Opportunity not found</h1>
          <p><a href="/opportunities">Back to opportunities</a></p>
        </section>`,
        {
          user: context.data?.user,
          env: context.data?.env,
          activeNav: '/opportunities',
        }
      ),
      { status: 404 }
    );
  }
  return renderEditForm(context, { opportunity: opp });
}
