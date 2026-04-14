// functions/accounts/[id]/index.js
//
// GET  /accounts/:id  — account detail (overview, contacts, activity feed)
// POST /accounts/:id  — update account (from the edit form)
//
// The detail page has three tabs rendered as stacked cards on one page
// (we'll break them into true tabs when the detail pages get busier).

import { one, all, stmt, batch } from '../../lib/db.js';
import { auditStmt, diff } from '../../lib/audit.js';
import { validateAccount } from '../../lib/validators.js';
import { layout, htmlResponse, html, raw, escape } from '../../lib/layout.js';
import { now } from '../../lib/ids.js';
import { redirectWithFlash, formBody, readFlash } from '../../lib/http.js';
import {
  loadAddresses,
  renderAddressEditor,
  addressEditorScript,
  parseAddressForm,
  buildAddressStatements,
} from '../../lib/address_editor.js';

const UPDATE_FIELDS = [
  'name',
  'segment',
  'phone',
  'website',
  'address_billing',
  'address_physical',
  'notes',
  'owner_user_id',
];

const SEGMENT_OPTIONS = [
  { value: '', label: '— None —' },
  { value: 'WROV', label: 'WROV' },
  { value: 'Research', label: 'Research' },
  { value: 'Defense', label: 'Defense' },
  { value: 'Commercial', label: 'Commercial' },
  { value: 'Other', label: 'Other' },
];

// ---- helpers for inline-editable fields ----------------------------------

function inlineText(field, value, opts = {}) {
  const display = value || opts.placeholder || '—';
  const displayClass = value ? '' : 'muted';
  return html`<span class="ie" data-field="${field}" data-type="text" ${opts.inputType ? `data-input-type="${opts.inputType}"` : ''}>
    <span class="ie-display ${displayClass}">${escape(display)}</span>
  </span>`;
}

function inlineTextarea(field, value, opts = {}) {
  const display = value || opts.placeholder || '—';
  const displayClass = value ? '' : 'muted';
  return html`<span class="ie" data-field="${field}" data-type="textarea">
    <span class="ie-display ${displayClass}">${escape(display)}</span>
    <span class="ie-raw" hidden>${escape(value ?? '')}</span>
  </span>`;
}

function inlineSelect(field, value, options) {
  const selectedOpt = options.find(o => o.value === (value ?? ''));
  const display = selectedOpt?.label || value || '—';
  const displayClass = value ? '' : 'muted';
  const optJson = JSON.stringify(options);
  return html`<span class="ie" data-field="${field}" data-type="select" data-options='${escape(optJson)}'>
    <span class="ie-display ${displayClass}">${escape(display)}</span>
  </span>`;
}

export async function onRequestGet(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const accountId = params.id;

  const account = await one(
    env.DB,
    `SELECT a.*, u.display_name AS owner_name, u.email AS owner_email
       FROM accounts a
       LEFT JOIN users u ON u.id = a.owner_user_id
      WHERE a.id = ?`,
    [accountId]
  );
  if (!account) return notFound(context);

  const contacts = await all(
    env.DB,
    `SELECT id, first_name, last_name, title, email, phone, mobile, is_primary
       FROM contacts
      WHERE account_id = ?
      ORDER BY is_primary DESC, last_name, first_name`,
    [accountId]
  );

  const addresses = await loadAddresses(env.DB, accountId);

  const users = await all(
    env.DB,
    `SELECT id, display_name, email FROM users WHERE active = 1 ORDER BY display_name`
  );

  const ownerOptions = [
    { value: '', label: '— None —' },
    ...users.map(u => ({ value: u.id, label: u.display_name ?? u.email })),
  ];

  const events = await all(
    env.DB,
    `SELECT ae.event_type, ae.at, ae.summary, ae.changes_json,
            ae.entity_type, ae.entity_id, u.email AS user_email, u.display_name AS user_name
       FROM audit_events ae
       LEFT JOIN users u ON u.id = ae.user_id
      WHERE (ae.entity_type = 'account' AND ae.entity_id = ?)
         OR (ae.entity_type = 'contact' AND ae.entity_id IN
             (SELECT id FROM contacts WHERE account_id = ?))
      ORDER BY ae.at DESC
      LIMIT 100`,
    [accountId, accountId]
  );

  const body = html`
    <section class="card" x-data="acctInline('${escape(account.id)}')">
      <div class="card-header">
        <div>
          <h1>${inlineText('name', account.name)}</h1>
        </div>
        <div class="header-actions">
          <form method="post" action="/accounts/${escape(account.id)}/delete"
                onsubmit="return confirm('Delete ${escape(account.name)} and all its contacts? This cannot be undone.');"
                style="display:inline">
            <button type="submit" class="btn danger">Delete</button>
          </form>
        </div>
      </div>

      <div class="detail-grid">
        <div class="detail-pair">
          <span class="detail-label">Alias</span>
          <span class="detail-value">${inlineText('alias', account.alias, { placeholder: 'Click to set a short nickname\u2026' })}</span>
        </div>
        <div class="detail-pair">
          <span class="detail-label">Segment</span>
          <span class="detail-value">${inlineSelect('segment', account.segment, SEGMENT_OPTIONS)}</span>
        </div>
        <div class="detail-pair">
          <span class="detail-label">Phone</span>
          <span class="detail-value">${inlineText('phone', account.phone)}</span>
        </div>
        <div class="detail-pair">
          <span class="detail-label">Website</span>
          <span class="detail-value">${inlineText('website', account.website)}</span>
        </div>
        <div class="detail-pair">
          <span class="detail-label">Owner</span>
          <span class="detail-value">${inlineSelect('owner_user_id', account.owner_user_id, ownerOptions)}</span>
        </div>
      </div>

      <form method="post" action="/accounts/${escape(account.id)}/addresses" class="inline-address-form">
        ${renderAddressEditor(addresses)}
        <div class="form-actions" style="margin-top:0.5rem">
          <button type="submit" class="btn primary">Save addresses</button>
        </div>
      </form>

      <h3 style="margin-top:1rem">Notes</h3>
      ${inlineTextarea('notes', account.notes, { placeholder: 'Click to add notes…' })}
    </section>

    <section class="card">
      <div class="card-header">
        <h2>Contacts (${contacts.length})</h2>
        <a class="btn primary" href="/accounts/${escape(account.id)}/contacts/new">New contact</a>
      </div>

      ${contacts.length === 0
        ? html`<p class="muted">No contacts yet.</p>`
        : html`
          <table class="data">
            <thead>
              <tr>
                <th>First</th>
                <th>Last</th>
                <th>Title</th>
                <th>Email</th>
                <th>Phone</th>
                <th>Primary</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${contacts.map(c => {
                const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || '(no name)';
                return html`<tr x-data="contactInline('${escape(c.id)}')">
                  <td><span class="ie" data-field="first_name" data-type="text" @click="activate($el)"><span class="ie-display">${escape(c.first_name ?? '')}</span></span></td>
                  <td><span class="ie" data-field="last_name" data-type="text" @click="activate($el)"><span class="ie-display"><strong>${escape(c.last_name ?? '')}</strong></span></span></td>
                  <td><span class="ie" data-field="title" data-type="text" @click="activate($el)"><span class="ie-display">${escape(c.title ?? '')}</span></span></td>
                  <td><span class="ie" data-field="email" data-type="text" @click="activate($el)"><span class="ie-display">${c.email ? html`<a href="mailto:${escape(c.email)}" @click.stop>${escape(c.email)}</a>` : html`<span class="muted">—</span>`}</span></span></td>
                  <td><span class="ie" data-field="phone" data-type="text" @click="activate($el)"><span class="ie-display">${escape(c.phone ?? '')}</span></span></td>
                  <td>${c.is_primary ? html`<span class="pill pill-success">primary</span>` : ''}</td>
                  <td class="row-actions">
                    <form method="post" action="/contacts/${escape(c.id)}/delete"
                          onsubmit="return confirm('Delete contact ${escape(name)}?');"
                          style="display:inline">
                      <button type="submit" class="btn btn-sm danger">Delete</button>
                    </form>
                  </td>
                </tr>`; })}
            </tbody>
          </table>
        `}
    </section>

    <section class="card">
      <h2>Activity</h2>
      ${events.length === 0
        ? html`<p class="muted">No activity yet.</p>`
        : html`
          <ul class="activity">
            ${raw(
              events
                .map((e) => {
                  const who = escape(e.user_name ?? e.user_email ?? 'system');
                  const when = escape(formatTimestamp(e.at));
                  const scope = e.entity_type === 'contact' ? ' <small class="muted">(contact)</small>' : '';
                  const summary = escape(e.summary ?? `${e.event_type} ${e.entity_type}`);
                  const changes = renderChanges(e.changes_json);
                  return `<li>
                    <div class="activity-head">
                      <strong>${who}</strong>
                      <span class="activity-type">${escape(e.event_type)}</span>${scope}
                      <span class="activity-when muted">${when}</span>
                    </div>
                    <div>${summary}</div>
                    ${changes}
                  </li>`;
                })
                .join('')
            )}
          </ul>
        `}
    </section>

    <script>
    function acctInline(acctId) {
      const patchUrl = '/accounts/' + acctId + '/patch';
      return {
        init() {
          this.$el.querySelectorAll('.ie').forEach(el => {
            el.addEventListener('click', () => this.activate(el));
          });
        },
        activate(el) {
          if (el.querySelector('.ie-input')) return;
          const field = el.dataset.field;
          const type = el.dataset.type;
          const display = el.querySelector('.ie-display');
          const rawEl = el.querySelector('.ie-raw');
          const currentValue = rawEl ? rawEl.textContent : (display.classList.contains('muted') ? '' : display.textContent.trim());

          let input;
          if (type === 'select') {
            input = document.createElement('select');
            input.className = 'ie-input';
            const options = JSON.parse(el.dataset.options || '[]');
            options.forEach(o => {
              const opt = document.createElement('option');
              opt.value = o.value;
              opt.textContent = o.label;
              if (o.value === (currentValue || '')) opt.selected = true;
              input.appendChild(opt);
            });
            input.addEventListener('change', () => this.save(el, input));
            input.addEventListener('blur', () => {
              setTimeout(() => this.deactivate(el, input), 150);
            });
          } else if (type === 'textarea') {
            input = document.createElement('textarea');
            input.className = 'ie-input';
            input.rows = 3;
            input.value = currentValue;
            input.addEventListener('blur', () => this.save(el, input));
            input.addEventListener('keydown', (e) => {
              if (e.key === 'Escape') { this.deactivate(el, input); }
            });
          } else {
            input = document.createElement('input');
            input.type = el.dataset.inputType || 'text';
            input.className = 'ie-input';
            input.value = currentValue;
            input.addEventListener('blur', () => this.save(el, input));
            input.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') { e.preventDefault(); this.save(el, input); }
              if (e.key === 'Escape') { this.deactivate(el, input); }
            });
          }

          display.style.display = 'none';
          el.appendChild(input);
          input.focus();
          if (input.select) input.select();
        },
        async save(el, input) {
          const field = el.dataset.field;
          const value = input.value;
          this.deactivate(el, input);

          el.classList.add('ie-saving');
          try {
            const res = await fetch(patchUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ field, value }),
            });
            const data = await res.json();
            if (!data.ok) {
              el.classList.add('ie-error');
              setTimeout(() => el.classList.remove('ie-error'), 2000);
              return;
            }
            const display = el.querySelector('.ie-display');
            const rawEl = el.querySelector('.ie-raw');
            if (el.dataset.type === 'select') {
              const options = JSON.parse(el.dataset.options || '[]');
              const opt = options.find(o => o.value === (data.value || ''));
              display.textContent = opt ? opt.label : (data.value || '\u2014');
            } else {
              display.textContent = data.value || '\u2014';
            }
            display.classList.toggle('muted', !data.value);
            if (rawEl) rawEl.textContent = data.value ?? '';

            // Update page title if name changed
            if (field === 'name' && data.value) {
              document.title = data.value + ' \u2014 PMS';
              const crumb = document.querySelector('.breadcrumbs span:last-child, .breadcrumbs a:last-child');
            }

            el.classList.add('ie-saved');
            setTimeout(() => el.classList.remove('ie-saved'), 1200);
          } catch (err) {
            el.classList.add('ie-error');
            setTimeout(() => el.classList.remove('ie-error'), 2000);
          } finally {
            el.classList.remove('ie-saving');
          }
        },
        deactivate(el, input) {
          if (input && input.parentNode === el) el.removeChild(input);
          const display = el.querySelector('.ie-display');
          if (display) display.style.display = '';
        },
      };
    }

    ${raw(addressEditorScript())}

    function contactInline(contactId) {
      const patchUrl = '/contacts/' + contactId + '/patch';
      return {
        activate(el) {
          if (el.querySelector('.ie-input')) return;
          const field = el.dataset.field;
          const display = el.querySelector('.ie-display');
          const currentValue = display.textContent.trim() === '—' ? '' : display.textContent.trim();
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'ie-input';
          input.value = currentValue;
          input.addEventListener('blur', () => this.save(el, input));
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); this.save(el, input); }
            if (e.key === 'Escape') { this.deactivate(el, input); }
          });
          display.style.display = 'none';
          el.appendChild(input);
          input.focus();
          input.select();
        },
        async save(el, input) {
          const field = el.dataset.field;
          const value = input.value;
          this.deactivate(el, input);
          el.classList.add('ie-saving');
          try {
            const res = await fetch(patchUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ field, value }),
            });
            const data = await res.json();
            if (!data.ok) {
              el.classList.add('ie-error');
              setTimeout(() => el.classList.remove('ie-error'), 2000);
              return;
            }
            const display = el.querySelector('.ie-display');
            if (field === 'email' && data.value) {
              display.innerHTML = '<a href="mailto:' + data.value + '">' + data.value + '</a>';
            } else {
              display.textContent = data.value || '—';
              display.classList.toggle('muted', !data.value);
            }
            el.classList.add('ie-saved');
            setTimeout(() => el.classList.remove('ie-saved'), 1200);
          } catch (err) {
            el.classList.add('ie-error');
            setTimeout(() => el.classList.remove('ie-error'), 2000);
          } finally {
            el.classList.remove('ie-saving');
          }
        },
        deactivate(el, input) {
          if (input && input.parentNode === el) el.removeChild(input);
          const display = el.querySelector('.ie-display');
          if (display) display.style.display = '';
        },
      };
    }
    </script>
  `;

  return htmlResponse(
    layout(account.name, body, {
      user,
      env: data?.env,
      activeNav: '/accounts',
      flash: readFlash(url),
      breadcrumbs: [
        { label: 'Accounts', href: '/accounts' },
        { label: escape(account.name) },
      ],
    })
  );
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const accountId = params.id;

  const before = await one(
    env.DB,
    `SELECT * FROM accounts WHERE id = ?`,
    [accountId]
  );
  if (!before) return notFound(context);

  const input = await formBody(request);
  const { ok, value, errors } = validateAccount(input);
  const submittedAddresses = parseAddressForm(input);

  if (!ok) {
    // Re-render the edit form with errors, preserving the user's in-flight
    // address edits.
    const { renderEditForm } = await import('./edit.js');
    return renderEditForm(context, {
      account: { ...before, ...input },
      errors,
      addresses: submittedAddresses,
    });
  }

  const existingAddresses = await loadAddresses(env.DB, accountId);

  // Keep the denormalized convenience columns on accounts in sync with the
  // submitted list (first default-or-first wins per kind).
  const firstBilling =
    submittedAddresses.find((a) => a.kind === 'billing' && a.is_default) ||
    submittedAddresses.find((a) => a.kind === 'billing');
  const firstPhysical =
    submittedAddresses.find((a) => a.kind === 'physical' && a.is_default) ||
    submittedAddresses.find((a) => a.kind === 'physical');

  const ts = now();
  const after = {
    ...value,
    address_billing: firstBilling?.address ?? null,
    address_physical: firstPhysical?.address ?? null,
  };
  const changes = diff(before, after, UPDATE_FIELDS);

  const { statements: addrStmts, changes: addrChanges } = buildAddressStatements(
    env.DB,
    accountId,
    submittedAddresses,
    existingAddresses,
    user
  );

  const statements = [
    stmt(
      env.DB,
      `UPDATE accounts
          SET name = ?, segment = ?, phone = ?, website = ?,
              address_billing = ?, address_physical = ?, notes = ?,
              owner_user_id = ?, updated_at = ?
        WHERE id = ?`,
      [
        value.name,
        value.segment,
        value.phone,
        value.website,
        after.address_billing,
        after.address_physical,
        value.notes,
        value.owner_user_id,
        ts,
        accountId,
      ]
    ),
    ...addrStmts,
  ];

  // Only write an audit event if something actually changed, so that a
  // plain re-save doesn't pollute the timeline.
  const addressesDirty =
    addrChanges.inserted > 0 || addrChanges.updated > 0 || addrChanges.deleted > 0;
  if (changes || addressesDirty) {
    statements.push(
      auditStmt(env.DB, {
        entityType: 'account',
        entityId: accountId,
        eventType: 'updated',
        user,
        summary: `Updated account "${value.name}"`,
        changes: {
          ...(changes || {}),
          ...(addressesDirty ? { addresses: addrChanges } : {}),
        },
      })
    );
  }

  await batch(env.DB, statements);

  return redirectWithFlash(`/accounts/${accountId}`, `Saved.`);
}

// -- helpers ---------------------------------------------------------------

function ensureHttp(url) {
  if (!url) return '';
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function formatTimestamp(iso) {
  if (!iso) return '';
  // Show "2026-04-10 17:42" — short and unambiguous.
  return iso.replace('T', ' ').replace(/\.\d+Z?$/, '').slice(0, 16);
}

function renderChanges(json) {
  if (!json) return '';
  let obj;
  try {
    obj = JSON.parse(json);
  } catch {
    return '';
  }
  if (!obj || typeof obj !== 'object') return '';
  const keys = Object.keys(obj);
  if (keys.length === 0) return '';
  // If the object is a "diff" shape ({ field: { from, to } }), render
  // just the field names. Otherwise, render as "created with" details.
  const isDiff = keys.every(
    (k) => obj[k] && typeof obj[k] === 'object' && 'from' in obj[k] && 'to' in obj[k]
  );
  if (isDiff) {
    return `<div class="activity-changes"><small class="muted">Changed: ${keys.map((k) => `<code>${escape(k)}</code>`).join(', ')}</small></div>`;
  }
  return '';
}

function notFound(context) {
  const { data } = context;
  return htmlResponse(
    layout(
      'Account not found',
      `<section class="card">
        <h1>Account not found</h1>
        <p><a href="/accounts">Back to accounts</a></p>
      </section>`,
      { user: data?.user, env: data?.env, activeNav: '/accounts' }
    ),
    { status: 404 }
  );
}
