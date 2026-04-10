// functions/accounts/[id]/contacts/index.js
//
// POST /accounts/:id/contacts — create a new contact under an account.
//
// If is_primary is set, demote any existing primary on this account in
// the same batch so there's always at most one primary.

import { one, stmt, batch } from '../../../lib/db.js';
import { auditStmt } from '../../../lib/audit.js';
import { validateContact } from '../../../lib/validators.js';
import { uuid, now } from '../../../lib/ids.js';
import { redirectWithFlash, formBody } from '../../../lib/http.js';
import { layout, htmlResponse } from '../../../lib/layout.js';

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const accountId = params.id;

  const account = await one(
    env.DB,
    `SELECT id, name FROM accounts WHERE id = ?`,
    [accountId]
  );
  if (!account) {
    return htmlResponse(
      layout('Not found', '<section class="card"><h1>Account not found</h1></section>', {
        user, env: data?.env, activeNav: '/accounts',
      }),
      { status: 404 }
    );
  }

  const input = { ...(await formBody(request)), account_id: accountId };
  const { ok, value, errors } = validateContact(input);

  if (!ok) {
    const { renderNewContactForm } = await import('./new.js');
    return renderNewContactForm(context, { account, values: input, errors });
  }

  const id = uuid();
  const ts = now();
  const displayName = [value.first_name, value.last_name].filter(Boolean).join(' ') || '(no name)';

  const statements = [];

  // If the new contact should be primary, clear any existing primary on this account.
  if (value.is_primary) {
    statements.push(
      stmt(
        env.DB,
        `UPDATE contacts SET is_primary = 0, updated_at = ? WHERE account_id = ? AND is_primary = 1`,
        [ts, accountId]
      )
    );
  }

  statements.push(
    stmt(
      env.DB,
      `INSERT INTO contacts
         (id, account_id, first_name, last_name, title, email, phone, mobile,
          is_primary, created_at, updated_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        accountId,
        value.first_name,
        value.last_name,
        value.title,
        value.email,
        value.phone,
        value.mobile,
        value.is_primary,
        ts,
        ts,
        user?.id ?? null,
      ]
    )
  );

  statements.push(
    auditStmt(env.DB, {
      entityType: 'contact',
      entityId: id,
      eventType: 'created',
      user,
      summary: `Created contact "${displayName}" on ${account.name}${value.is_primary ? ' (primary)' : ''}`,
      changes: value,
    })
  );

  await batch(env.DB, statements);

  return redirectWithFlash(
    `/accounts/${accountId}`,
    `Contact "${displayName}" added.`
  );
}
