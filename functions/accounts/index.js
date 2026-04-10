// functions/accounts/index.js
//
// GET  /accounts        — list all accounts (with optional search)
// POST /accounts        — create a new account (called by the new form)

import { all, stmt, batch } from '../lib/db.js';
import { auditStmt } from '../lib/audit.js';
import { validateAccount } from '../lib/validators.js';
import { layout, htmlResponse, html, raw, escape } from '../lib/layout.js';
import { uuid, now } from '../lib/ids.js';
import {
  redirectWithFlash,
  formBody,
  readFlash,
  isPopupMode,
  popupCloseResponse,
} from '../lib/http.js';
import { parseAddressForm, buildAddressStatements } from '../lib/address_editor.js';

/**
 * GET /accounts — list accounts with optional ?q= search.
 */
export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();

  const rows = q
    ? await all(
        env.DB,
        `SELECT a.id, a.name, a.segment, a.phone, a.website, a.updated_at,
                (SELECT COUNT(*) FROM contacts c WHERE c.account_id = a.id) AS contact_count
           FROM accounts a
          WHERE a.name LIKE ? COLLATE NOCASE
             OR a.segment LIKE ? COLLATE NOCASE
          ORDER BY a.name
          LIMIT 200`,
        [`%${q}%`, `%${q}%`]
      )
    : await all(
        env.DB,
        `SELECT a.id, a.name, a.segment, a.phone, a.website, a.updated_at,
                (SELECT COUNT(*) FROM contacts c WHERE c.account_id = a.id) AS contact_count
           FROM accounts a
          ORDER BY a.name
          LIMIT 200`
      );

  const body = html`
    <section class="card">
      <div class="card-header">
        <h1>Accounts</h1>
        <a class="btn primary" href="/accounts/new">New account</a>
      </div>

      <form method="get" action="/accounts" class="inline-form">
        <input type="search" name="q" value="${q}" placeholder="Search by name or segment"
               autofocus>
        <button class="btn" type="submit">Search</button>
        ${q ? html`<a class="btn" href="/accounts">Clear</a>` : ''}
      </form>

      ${rows.length === 0
        ? html`<p class="muted">
            No accounts ${q ? html`match <code>${q}</code>` : 'yet'}. Start by
            <a href="/accounts/new">creating one</a>.
          </p>`
        : html`
          <table class="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Segment</th>
                <th>Phone</th>
                <th>Contacts</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              ${raw(
                rows
                  .map(
                    (r) => `<tr>
                      <td><a href="/accounts/${escape(r.id)}">${escape(r.name)}</a></td>
                      <td>${escape(r.segment ?? '')}</td>
                      <td>${escape(r.phone ?? '')}</td>
                      <td>${r.contact_count}</td>
                      <td><small class="muted">${escape((r.updated_at ?? '').slice(0, 10))}</small></td>
                    </tr>`
                  )
                  .join('')
              )}
            </tbody>
          </table>
        `}
    </section>
  `;

  return htmlResponse(
    layout('Accounts', body, {
      user,
      env: data?.env,
      activeNav: '/accounts',
      flash: readFlash(url),
    })
  );
}

/**
 * POST /accounts — create a new account.
 */
export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  const input = await formBody(request);
  const { ok, value, errors } = validateAccount(input);
  const submittedAddresses = parseAddressForm(input);

  if (!ok) {
    // Re-render the new form with the errors inline. Hand back the parsed
    // address rows so the user doesn't lose them.
    const { renderNewForm } = await import('./new.js');
    return renderNewForm(context, {
      values: input,
      errors,
      addresses: submittedAddresses,
    });
  }

  const id = uuid();
  const ts = now();

  // Denormalized convenience columns on accounts: pick the first default
  // billing / physical (or just the first of each kind) so legacy readers
  // that still hit accounts.address_billing / address_physical keep working.
  const firstBilling =
    submittedAddresses.find((a) => a.kind === 'billing' && a.is_default) ||
    submittedAddresses.find((a) => a.kind === 'billing');
  const firstPhysical =
    submittedAddresses.find((a) => a.kind === 'physical' && a.is_default) ||
    submittedAddresses.find((a) => a.kind === 'physical');

  const statements = [
    stmt(
      env.DB,
      `INSERT INTO accounts
         (id, name, segment, address_billing, address_physical,
          phone, website, notes, owner_user_id,
          created_at, updated_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        value.name,
        value.segment,
        firstBilling?.address ?? null,
        firstPhysical?.address ?? null,
        value.phone,
        value.website,
        value.notes,
        user?.id ?? null,
        ts,
        ts,
        user?.id ?? null,
      ]
    ),
  ];

  // Insert the normalized address rows (no existing rows on create).
  const { statements: addrStmts } = buildAddressStatements(
    env.DB,
    id,
    submittedAddresses,
    [],
    user
  );
  statements.push(...addrStmts);

  statements.push(
    auditStmt(env.DB, {
      entityType: 'account',
      entityId: id,
      eventType: 'created',
      user,
      summary: `Created account "${value.name}"`,
      changes: { ...value, address_count: submittedAddresses.length },
    })
  );

  await batch(env.DB, statements);

  if (isPopupMode(request, input)) {
    return popupCloseResponse('pms.account.created', {
      account: { id, name: value.name },
    });
  }

  return redirectWithFlash(`/accounts/${id}`, `Account "${value.name}" created.`);
}
