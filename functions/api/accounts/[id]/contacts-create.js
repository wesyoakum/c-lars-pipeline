// functions/api/accounts/[id]/contacts-create.js
//
// POST /api/accounts/:id/contacts-create — JSON endpoint to create a contact.
// Returns { ok, contact: { id, first_name, last_name } }.

import { one, stmt, batch } from '../../../lib/db.js';
import { auditStmt } from '../../../lib/audit.js';
import { uuid, now } from '../../../lib/ids.js';

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const accountId = params.id;

  const account = await one(env.DB, 'SELECT id FROM accounts WHERE id = ?', [accountId]);
  if (!account) return json({ ok: false, error: 'Account not found' }, 404);

  let body;
  try { body = await request.json(); } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const firstName = (body.first_name || '').trim();
  const lastName = (body.last_name || '').trim();
  if (!firstName && !lastName) {
    return json({ ok: false, error: 'Name is required' }, 400);
  }

  const id = uuid();
  const ts = now();
  const email = (body.email || '').trim() || null;
  const phone = (body.phone || '').trim() || null;
  const title = (body.title || '').trim() || null;

  await batch(env.DB, [
    stmt(env.DB,
      `INSERT INTO contacts (id, account_id, first_name, last_name, title, email, phone, is_primary, created_at, updated_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [id, accountId, firstName, lastName, title, email, phone, ts, ts, user?.id]),
    auditStmt(env.DB, {
      entityType: 'contact',
      entityId: id,
      eventType: 'created',
      user,
      summary: `Created contact ${firstName} ${lastName} on account`,
    }),
  ]);

  return json({ ok: true, contact: { id, first_name: firstName, last_name: lastName } });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
