// functions/contacts/[id]/patch.js
//
// POST /contacts/:id/patch — inline field save (JSON).
// Accepts { field, value } and updates a single contact field.

import { one, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { now } from '../../lib/ids.js';

const PATCHABLE = new Set([
  'first_name', 'last_name', 'title', 'email', 'phone', 'mobile', 'is_primary', 'notes',
]);

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const contactId = params.id;

  let body;
  try { body = await request.json(); } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const { field, value: rawValue } = body;
  if (!field || !PATCHABLE.has(field)) {
    return json({ ok: false, error: `Field "${field}" is not editable` }, 400);
  }

  const contact = await one(env.DB, 'SELECT * FROM contacts WHERE id = ?', [contactId]);
  if (!contact) return json({ ok: false, error: 'Not found' }, 404);

  let newValue;
  if (field === 'is_primary') {
    newValue = rawValue === '1' || rawValue === true || rawValue === 1 ? 1 : 0;
  } else {
    newValue = (typeof rawValue === 'string' ? rawValue.trim() : rawValue) || null;
  }

  const ts = now();
  const changes = {};
  if (contact[field] !== newValue) {
    changes[field] = { from: contact[field], to: newValue };
  }

  const stmts = [
    stmt(env.DB, `UPDATE contacts SET ${field} = ?, updated_at = ? WHERE id = ?`, [newValue, ts, contactId]),
    auditStmt(env.DB, {
      entityType: 'contact',
      entityId: contactId,
      eventType: 'updated',
      user,
      summary: `Updated contact ${field}: ${contact.first_name} ${contact.last_name}`,
      changes,
    }),
  ];

  // If setting is_primary = 1, clear other primaries on the same account
  if (field === 'is_primary' && newValue === 1) {
    stmts.unshift(
      stmt(env.DB, `UPDATE contacts SET is_primary = 0 WHERE account_id = ? AND id != ?`, [contact.account_id, contactId])
    );
  }

  await batch(env.DB, stmts);

  return json({ ok: true, field, value: newValue });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
