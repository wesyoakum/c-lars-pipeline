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
  renderAddressView,
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
];

export async function onRequestGet(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const accountId = params.id;

  const account = await one(
    env.DB,
    `SELECT * FROM accounts WHERE id = ?`,
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
    <section class="card">
      <div class="card-header">
        <div>
          <h1>${account.name}</h1>
          <p class="muted">
            ${account.segment ? html`<span class="pill">${account.segment}</span> ` : ''}
            ${account.phone ? html`· ${account.phone} ` : ''}
            ${account.website
              ? html`· <a href="${escape(ensureHttp(account.website))}" target="_blank" rel="noopener">${account.website}</a>`
              : ''}
          </p>
        </div>
        <div class="header-actions">
          <a class="btn" href="/accounts/${escape(account.id)}/edit">Edit</a>
          <form method="post" action="/accounts/${escape(account.id)}/delete"
                onsubmit="return confirm('Delete ${escape(account.name)} and all its contacts? This cannot be undone.');"
                style="display:inline">
            <button type="submit" class="btn danger">Delete</button>
          </form>
        </div>
      </div>

      ${renderAddressView(addresses)}

      ${account.notes
        ? html`<p class="notes">${escape(account.notes)}</p>`
        : ''}
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
                <th>Name</th>
                <th>Title</th>
                <th>Email</th>
                <th>Phone</th>
                <th>Primary</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${raw(
                contacts
                  .map((c) => {
                    const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || '(no name)';
                    return `<tr>
                      <td><strong>${escape(name)}</strong></td>
                      <td>${escape(c.title ?? '')}</td>
                      <td>${c.email ? `<a href="mailto:${escape(c.email)}">${escape(c.email)}</a>` : ''}</td>
                      <td>${escape(c.phone ?? c.mobile ?? '')}</td>
                      <td>${c.is_primary ? '<span class="pill pill-success">primary</span>' : ''}</td>
                      <td>
                        <form method="post" action="/contacts/${escape(c.id)}/delete"
                              onsubmit="return confirm('Delete contact ${escape(name)}?');"
                              style="display:inline">
                          <button type="submit" class="btn btn-sm danger">Delete</button>
                        </form>
                      </td>
                    </tr>`;
                  })
                  .join('')
              )}
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
  `;

  return htmlResponse(
    layout(account.name, body, {
      user,
      env: data?.env,
      activeNav: '/accounts',
      flash: readFlash(url),
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
              updated_at = ?
        WHERE id = ?`,
      [
        value.name,
        value.segment,
        value.phone,
        value.website,
        after.address_billing,
        after.address_physical,
        value.notes,
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
