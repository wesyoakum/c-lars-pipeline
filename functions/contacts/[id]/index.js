// functions/contacts/[id]/index.js
//
// POST /contacts/:id — update a contact (fields + is_primary toggle).
//
// P0 keeps this simple: there's no dedicated edit page for contacts yet;
// edits happen from the parent account detail (M3+ will get a dedicated
// contact edit form if it becomes a pain point). This handler exists so
// mid-list "make primary" / "update email" fragments can POST here.

import { one, stmt, batch } from '../../lib/db.js';
import { auditStmt, diff } from '../../lib/audit.js';
import { validateContact } from '../../lib/validators.js';
import { now } from '../../lib/ids.js';
import { redirectWithFlash, formBody } from '../../lib/http.js';
import { layout, htmlResponse } from '../../lib/layout.js';

const FIELDS = ['first_name', 'last_name', 'title', 'email', 'phone', 'mobile', 'is_primary'];

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const contactId = params.id;

  const before = await one(
    env.DB,
    `SELECT * FROM contacts WHERE id = ?`,
    [contactId]
  );
  if (!before) {
    return htmlResponse(
      layout('Not found', '<section class="card"><h1>Contact not found</h1></section>', {
        user, env: data?.env, activeNav: '/accounts',
      }),
      { status: 404 }
    );
  }

  const input = { ...(await formBody(request)), account_id: before.account_id };
  const { ok, value, errors } = validateContact(input);
  if (!ok) {
    const firstError = Object.values(errors)[0] || 'Validation failed';
    return redirectWithFlash(`/accounts/${before.account_id}`, firstError, 'error');
  }

  const ts = now();
  const after = { ...value };
  const changes = diff(before, after, FIELDS);

  const statements = [];

  // Clear any other primary on the account if this one is being promoted.
  if (value.is_primary && !before.is_primary) {
    statements.push(
      stmt(
        env.DB,
        `UPDATE contacts SET is_primary = 0, updated_at = ? WHERE account_id = ? AND id != ? AND is_primary = 1`,
        [ts, before.account_id, contactId]
      )
    );
  }

  statements.push(
    stmt(
      env.DB,
      `UPDATE contacts
          SET first_name = ?, last_name = ?, title = ?, email = ?,
              phone = ?, mobile = ?, is_primary = ?, updated_at = ?
        WHERE id = ?`,
      [
        value.first_name,
        value.last_name,
        value.title,
        value.email,
        value.phone,
        value.mobile,
        value.is_primary,
        ts,
        contactId,
      ]
    )
  );

  const displayName = [value.first_name, value.last_name].filter(Boolean).join(' ') || '(no name)';
  statements.push(
    auditStmt(env.DB, {
      entityType: 'contact',
      entityId: contactId,
      eventType: 'updated',
      user,
      summary: `Updated contact "${displayName}"`,
      changes,
    })
  );

  await batch(env.DB, statements);

  return redirectWithFlash(
    `/accounts/${before.account_id}`,
    `Contact "${displayName}" updated.`
  );
}
