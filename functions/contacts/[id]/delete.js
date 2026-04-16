// functions/contacts/[id]/delete.js
//
// POST /contacts/:id/delete — delete a contact.

import { one, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { redirectWithFlash } from '../../lib/http.js';
import { layout, htmlResponse } from '../../lib/layout.js';

function wantsJson(request) {
  const a = request.headers.get('accept') || '';
  return a.includes('application/json') && !a.includes('text/html');
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const contactId = params.id;
  const json = wantsJson(request);

  const contact = await one(
    env.DB,
    `SELECT id, account_id, first_name, last_name FROM contacts WHERE id = ?`,
    [contactId]
  );
  if (!contact) {
    if (json) return jsonResponse({ ok: false, error: 'Contact not found' }, 404);
    return htmlResponse(
      layout('Not found', '<section class="card"><h1>Contact not found</h1></section>', {
        user, env: data?.env, activeNav: '/accounts',
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

  if (json) return jsonResponse({ ok: true, id: contactId });
  return redirectWithFlash(
    `/accounts/${contact.account_id}?tab=contacts`,
    `Contact "${displayName}" deleted.`
  );
}
