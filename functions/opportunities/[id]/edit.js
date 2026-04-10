// functions/opportunities/[id]/edit.js
//
// GET /opportunities/:id/edit — edit form.
//
// POST target is /opportunities/:id (index.js onRequestPost), which
// will re-render this page with inline errors on validation failure
// by importing renderEditForm() below.

import { one, all } from '../../lib/db.js';
import { layout, htmlResponse, html, escape } from '../../lib/layout.js';
import { readFlash } from '../../lib/http.js';

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
      `SELECT id, first_name, last_name FROM contacts WHERE account_id = ?
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

      <form method="post" action="/opportunities/${escape(opp.id)}" class="stacked">
        <label>
          <span>Title <em>*</em></span>
          <input type="text" name="title" required value="${escape(opp.title ?? '')}">
          ${errors.title ? html`<small class="field-error">${errors.title}</small>` : ''}
        </label>

        <div class="row">
          <label style="flex:1">
            <span>Account <em>*</em></span>
            <select name="account_id" required>
              <option value="">— Select account —</option>
              ${accounts.map(
                (a) =>
                  html`<option value="${escape(a.id)}" ${opp.account_id === a.id ? 'selected' : ''}>${a.name}</option>`
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
                  html`<option value="${t.value}" ${opp.transaction_type === t.value ? 'selected' : ''}>${t.label}</option>`
              )}
            </select>
            ${errors.transaction_type ? html`<small class="field-error">${errors.transaction_type}</small>` : ''}
          </label>
        </div>

        <label>
          <span>Primary contact</span>
          <select name="primary_contact_id">
            <option value="">— None —</option>
            ${contacts.map((c) => {
              const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || '(no name)';
              return html`<option value="${escape(c.id)}" ${opp.primary_contact_id === c.id ? 'selected' : ''}>${name}</option>`;
            })}
          </select>
        </label>

        <label>
          <span>Description</span>
          <textarea name="description" rows="4">${escape(opp.description ?? '')}</textarea>
        </label>

        <label>
          <span>How did the RFQ arrive?</span>
          <select name="rfq_format">
            ${RFQ_FORMAT_OPTIONS.map(
              (o) =>
                html`<option value="${o.value}" ${(opp.rfq_format ?? '') === o.value ? 'selected' : ''}>${o.label}</option>`
            )}
          </select>
        </label>

        <div class="row">
          <label style="flex:1">
            <span>Estimated value (USD)</span>
            <input type="number" name="estimated_value_usd" min="0" step="1"
                   value="${escape(opp.estimated_value_usd ?? '')}">
            ${errors.estimated_value_usd ? html`<small class="field-error">${errors.estimated_value_usd}</small>` : ''}
          </label>
          <label style="flex:1">
            <span>Expected close date</span>
            <input type="date" name="expected_close_date"
                   value="${escape(opp.expected_close_date ?? '')}">
            ${errors.expected_close_date ? html`<small class="field-error">${errors.expected_close_date}</small>` : ''}
          </label>
        </div>

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

        <fieldset style="border:1px solid var(--border); border-radius: var(--radius); padding: 0.75rem 1rem;">
          <legend style="font-size: 0.85rem; color: var(--fg-muted);">BANT-lite</legend>
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
              <span>Authority</span>
              <input type="text" name="bant_authority" value="${escape(opp.bant_authority ?? '')}">
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
  `;

  return htmlResponse(
    layout(`Edit ${opp.number ?? 'opportunity'}`, body, {
      user,
      env: data?.env,
      activeNav: '/opportunities',
      flash: readFlash(url),
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
