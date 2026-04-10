// functions/opportunities/new.js
//
// GET /opportunities/new — new-opportunity form.
//
// POST target is /opportunities (opportunities/index.js onRequestPost),
// which will re-render this page with inline errors on validation failure
// by importing renderNewForm() below.

import { all } from '../lib/db.js';
import { layout, htmlResponse, html, raw, escape } from '../lib/layout.js';
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

const SOURCE_OPTIONS = [
  { value: '', label: '— Not specified —' },
  { value: 'inbound', label: 'Inbound (customer reached out)' },
  { value: 'outreach', label: 'Outreach (we reached out)' },
  { value: 'referral', label: 'Referral' },
  { value: 'existing', label: 'Existing customer follow-on' },
  { value: 'other', label: 'Other' },
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

  // If an account is already selected, load its contacts so the user can
  // pick an Authority without a round-trip. On a fresh form we omit this
  // and let the client-side "Add contact" button kick in after the user
  // picks an account.
  const contacts = preselectAccount
    ? await all(
        env.DB,
        `SELECT id, first_name, last_name, title FROM contacts
          WHERE account_id = ?
          ORDER BY is_primary DESC, last_name, first_name`,
        [preselectAccount]
      )
    : [];

  const body = html`
    <section class="card">
      <h1>New opportunity</h1>
      <p class="muted">
        An opportunity is the spine of a deal. Cost builds, quotes,
        documents, and the Job handoff all hang off it.
      </p>

      <form method="post" action="/opportunities" class="stacked opp-form"
            data-initial-account="${escape(preselectAccount)}">
        <div class="row">
          <label style="flex:2">
            <span>Title <em>*</em></span>
            <input type="text" name="title" required value="${escape(values.title ?? '')}"
                   placeholder="e.g. LARS-200 refurb for Acme Subsea">
            ${errors.title ? html`<small class="field-error">${errors.title}</small>` : ''}
          </label>
          <label style="flex:1">
            <span>Number</span>
            <input type="text" name="number" inputmode="numeric"
                   value="${escape(values.number ?? '')}"
                   placeholder="auto (next: 25001+)">
            ${errors.number ? html`<small class="field-error">${errors.number}</small>` : ''}
            <small class="muted">Leave blank to auto-allocate.</small>
          </label>
        </div>

        <div class="row">
          <label style="flex:1">
            <span>Account <em>*</em></span>
            <div class="picker-row">
              <select name="account_id" required data-role="account-select">
                <option value="">— Select account —</option>
                ${accounts.map(
                  (a) =>
                    html`<option value="${escape(a.id)}" ${preselectAccount === a.id ? 'selected' : ''}>${a.name}</option>`
                )}
              </select>
              <button type="button" class="btn btn-sm" data-action="new-account">+ New account</button>
            </div>
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

        <div class="row">
          <label style="flex:1">
            <span>How did the RFQ arrive?</span>
            <select name="rfq_format">
              ${RFQ_FORMAT_OPTIONS.map(
                (o) =>
                  html`<option value="${o.value}" ${(values.rfq_format ?? '') === o.value ? 'selected' : ''}>${o.label}</option>`
              )}
            </select>
            ${errors.rfq_format ? html`<small class="field-error">${errors.rfq_format}</small>` : ''}
          </label>
          <label style="flex:1">
            <span>Source</span>
            <select name="source">
              ${SOURCE_OPTIONS.map(
                (o) =>
                  html`<option value="${o.value}" ${(values.source ?? '') === o.value ? 'selected' : ''}>${o.label}</option>`
              )}
            </select>
            ${errors.source ? html`<small class="field-error">${errors.source}</small>` : ''}
          </label>
        </div>

        <div class="row">
          <label style="flex:1">
            <span>Estimated value (USD)</span>
            <input type="number" name="estimated_value_usd" min="0" step="1"
                   value="${escape(values.estimated_value_usd ?? '')}">
            ${errors.estimated_value_usd ? html`<small class="field-error">${errors.estimated_value_usd}</small>` : ''}
          </label>
          <label style="flex:1">
            <span>Probability (%)</span>
            <input type="number" name="probability" min="0" max="100" step="1"
                   value="${escape(values.probability ?? '')}"
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
                     value="${escape(values.rfq_received_date ?? '')}">
              ${errors.rfq_received_date ? html`<small class="field-error">${errors.rfq_received_date}</small>` : ''}
            </label>
            <label style="flex:1">
              <span>RFQ due</span>
              <input type="date" name="rfq_due_date"
                     value="${escape(values.rfq_due_date ?? '')}">
              ${errors.rfq_due_date ? html`<small class="field-error">${errors.rfq_due_date}</small>` : ''}
            </label>
          </div>
          <div class="row">
            <label style="flex:1">
              <span>RFI due</span>
              <input type="date" name="rfi_due_date"
                     value="${escape(values.rfi_due_date ?? '')}">
              ${errors.rfi_due_date ? html`<small class="field-error">${errors.rfi_due_date}</small>` : ''}
            </label>
            <label style="flex:1">
              <span>Quoted</span>
              <input type="date" name="quoted_date"
                     value="${escape(values.quoted_date ?? '')}">
              ${errors.quoted_date ? html`<small class="field-error">${errors.quoted_date}</small>` : ''}
            </label>
          </div>
          <div class="row">
            <label style="flex:1">
              <span>Expected close</span>
              <input type="date" name="expected_close_date"
                     value="${escape(values.expected_close_date ?? '')}">
              ${errors.expected_close_date ? html`<small class="field-error">${errors.expected_close_date}</small>` : ''}
            </label>
            <div style="flex:1"></div>
          </div>
        </fieldset>

        <fieldset class="qualification-box">
          <legend>Qualification</legend>
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
              <span>Authority (contact)</span>
              <div class="picker-row">
                <select name="bant_authority_contact_id" data-role="authority-select">
                  <option value="">— None —</option>
                  ${contacts.map((c) => {
                    const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || '(no name)';
                    const titleSuffix = c.title ? ` — ${c.title}` : '';
                    return html`<option value="${escape(c.id)}" ${values.bant_authority_contact_id === c.id ? 'selected' : ''}>${name}${titleSuffix}</option>`;
                  })}
                </select>
                <button type="button" class="btn btn-sm" data-action="new-contact">+ New contact</button>
              </div>
              <input type="hidden" name="bant_authority" value="${escape(values.bant_authority ?? '')}">
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

    <script>${raw(oppPickerScript())}</script>
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

/**
 * Inline script for the opportunity form's on-the-fly picker behavior.
 *
 * - "+ New account" opens /accounts/new?popup=1 in a popup window. When
 *   the popup posts the created account back via window.postMessage with
 *   {type:'pms.account.created', account:{id,name}}, we append it to the
 *   account <select>, select it, and trigger a contacts reload.
 *
 * - "+ New contact" opens /accounts/:account_id/contacts/new?popup=1 and
 *   similarly listens for {type:'pms.contact.created', contact:{id,name}}.
 *
 * - When the account <select> changes we fetch /api/accounts/:id/contacts
 *   (JSON) and repopulate the authority contact dropdown.
 *
 * Returned as a plain string so it can be interpolated via raw() without
 * the html tagged template escaping angle brackets inside template
 * literals.
 */
export function oppPickerScript() {
  return `
(function() {
  const form = document.querySelector('form.opp-form');
  if (!form) return;
  const accountSelect = form.querySelector('select[data-role="account-select"]');
  const authoritySelect = form.querySelector('select[data-role="authority-select"]');
  const newAccountBtn = form.querySelector('button[data-action="new-account"]');
  const newContactBtn = form.querySelector('button[data-action="new-contact"]');

  function openPopup(url, name) {
    return window.open(url, name, 'width=720,height=780,resizable=yes,scrollbars=yes');
  }

  async function loadContactsFor(accountId) {
    if (!authoritySelect) return;
    if (!accountId) {
      authoritySelect.innerHTML = '<option value="">— None —</option>';
      return;
    }
    try {
      const res = await fetch('/api/accounts/' + encodeURIComponent(accountId) + '/contacts');
      if (!res.ok) throw new Error('failed');
      const contacts = await res.json();
      const opts = ['<option value="">— None —</option>'];
      for (const c of contacts) {
        const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || '(no name)';
        const titleSuffix = c.title ? ' — ' + c.title : '';
        opts.push('<option value="' + c.id + '">' + escapeHtml(name + titleSuffix) + '</option>');
      }
      authoritySelect.innerHTML = opts.join('');
    } catch (e) {
      console.warn('loadContactsFor failed', e);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  if (accountSelect) {
    accountSelect.addEventListener('change', () => loadContactsFor(accountSelect.value));
  }

  if (newAccountBtn) {
    newAccountBtn.addEventListener('click', () => {
      openPopup('/accounts/new?popup=1', 'pms-new-account');
    });
  }

  if (newContactBtn) {
    newContactBtn.addEventListener('click', () => {
      const accountId = accountSelect && accountSelect.value;
      if (!accountId) {
        alert('Pick an account first, then add a contact on that account.');
        return;
      }
      openPopup('/accounts/' + encodeURIComponent(accountId) + '/contacts/new?popup=1', 'pms-new-contact');
    });
  }

  window.addEventListener('message', (ev) => {
    if (!ev.data || typeof ev.data !== 'object') return;
    if (ev.data.type === 'pms.account.created' && ev.data.account) {
      const { id, name } = ev.data.account;
      if (accountSelect && !accountSelect.querySelector('option[value="' + id + '"]')) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = name;
        accountSelect.appendChild(opt);
      }
      if (accountSelect) {
        accountSelect.value = id;
        loadContactsFor(id);
      }
    }
    if (ev.data.type === 'pms.contact.created' && ev.data.contact) {
      const { id, first_name, last_name, title } = ev.data.contact;
      if (authoritySelect) {
        const opt = document.createElement('option');
        opt.value = id;
        const name = [first_name, last_name].filter(Boolean).join(' ') || '(no name)';
        opt.textContent = name + (title ? ' — ' + title : '');
        authoritySelect.appendChild(opt);
        authoritySelect.value = id;
      }
    }
  });
})();
`;
}

