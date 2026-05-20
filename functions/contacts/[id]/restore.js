// functions/contacts/[id]/restore.js
//
// POST /contacts/:id/restore — undo a soft-deleted contact.

import { one, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { restoreStmt } from '../../lib/soft-delete.js';
import { redirectWithFlash } from '../../lib/http.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const contactId = params.id;

  const contact = await one(
    env.DB,
    `SELECT id, account_id, first_name, last_name FROM contacts WHERE id = ? AND deleted_at IS NOT NULL`,
    [contactId]
  );
  if (!contact) {
    return redirectWithFlash('/accounts', 'Contact not found or not deleted.', 'error');
  }

  const displayName = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || '(no name)';

  await batch(env.DB, [
    restoreStmt(env.DB, 'contacts', contactId),
    auditStmt(env.DB, {
      entityType: 'contact',
      entityId: contactId,
      eventType: 'restored',
      user,
      summary: `Restored contact "${displayName}"`,
    }),
  ]);

  return redirectWithFlash(
    `/accounts/${contact.account_id}?tab=contacts`,
    `Contact "${displayName}" restored.`
  );
}
