// functions/contacts/[id]/delete.js
//
// POST /contacts/:id/delete — delete a contact.

import { one, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { redirectWithFlash } from '../../lib/http.js';
import { layout, htmlResponse } from '../../lib/layout.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const contactId = params.id;

  const contact = await one(
    env.DB,
    `SELECT id, account_id, first_name, last_name FROM contacts WHERE id = ?`,
    [contactId]
  );
  if (!contact) {
    return htmlResponse(
      layout('Not found', '<section class="card"><h1>Contact not found</h1></section>', {
        user, env: data?.env, commitSha: data?.commitSha, activeNav: '/accounts',
      }),
      { status: 404 }
    );
  }

  const displayName = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || '(no name)';

  await batch(env.DB, [
    auditStmt(env.DB, {
      entityType: 'contact',
      entityId: contactId,
      eventType: 'deleted',
      user,
      summary: `Deleted contact "${displayName}"`,
    }),
    stmt(env.DB, `DELETE FROM contacts WHERE id = ?`, [contactId]),
  ]);

  return redirectWithFlash(
    `/accounts/${contact.account_id}`,
    `Contact "${displayName}" deleted.`
  );
}
