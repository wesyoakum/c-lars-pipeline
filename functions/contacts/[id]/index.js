// functions/contacts/[id]/index.js
//
// POST /contacts/:id — update a contact (any business field, including
// moving the contact to a different account).
//
// On validation failure we re-render /contacts/:id/edit inline so the
// user doesn't lose their in-flight edits to a redirect.

import { one, stmt, batch } from '../../lib/db.js';
import { auditStmt, diff } from '../../lib/audit.js';
import { validateContact } from '../../lib/validators.js';
import { now } from '../../lib/ids.js';
import { redirectWithFlash, formBody } from '../../lib/http.js';
import { layout, htmlResponse } from '../../lib/layout.js';

const FIELDS = [
  'account_id',
  'first_name',
  'last_name',
  'title',
  'email',
  'phone',
  'mobile',
  'is_primary',
  'notes',
];

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
        user, env: data?.env, commitSha: data?.commitSha, activeNav: '/accounts',
      }),
      { status: 404 }
    );
  }

  const input = await formBody(request);
  const { ok, value, errors } = validateContact(input);
  if (!ok) {
    const { renderEditForm } = await import('./edit.js');
    return renderEditForm(context, {
      contact: { ...before, ...input },
      errors,
    });
  }

  // If the user is moving the contact to a different account, sanity-check
  // that the target account exists so the FK error is friendly.
  if (value.account_id !== before.account_id) {
    const target = await one(env.DB, 'SELECT id FROM accounts WHERE id = ?', [value.account_id]);
    if (!target) {
      const { renderEditForm } = await import('./edit.js');
      return renderEditForm(context, {
        contact: { ...before, ...input },
        errors: { account_id: 'Account not found' },
      });
    }
  }

  const ts = now();
  const after = { ...value };
  const changes = diff(before, after, FIELDS);

  const statements = [];

  // Clear any other primary on the (possibly new) account if this one is
  // being promoted. Demote on the old account too if we're moving away.
  if (value.is_primary) {
    statements.push(
      stmt(
        env.DB,
        `UPDATE contacts SET is_primary = 0, updated_at = ?
          WHERE account_id = ? AND id != ? AND is_primary = 1`,
        [ts, value.account_id, contactId]
      )
    );
  }

  statements.push(
    stmt(
      env.DB,
      `UPDATE contacts
          SET account_id = ?, first_name = ?, last_name = ?, title = ?,
              email = ?, phone = ?, mobile = ?, is_primary = ?,
              notes = ?, updated_at = ?
        WHERE id = ?`,
      [
        value.account_id,
        value.first_name,
        value.last_name,
        value.title,
        value.email,
        value.phone,
        value.mobile,
        value.is_primary,
        value.notes,
        ts,
        contactId,
      ]
    )
  );

  const displayName = [value.first_name, value.last_name].filter(Boolean).join(' ') || '(no name)';
  if (changes) {
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
  }

  await batch(env.DB, statements);

  return redirectWithFlash(
    `/accounts/${value.account_id}`,
    `Contact "${displayName}" updated.`
  );
}
