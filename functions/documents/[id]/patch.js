// functions/documents/[id]/patch.js
//
// POST /documents/:id/patch — inline field save (JSON).
// Accepts { field, value } and updates title or kind.

import { one, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { now } from '../../lib/ids.js';

const PATCHABLE = new Set(['title', 'kind']);

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const docId = params.id;

  let body;
  try { body = await request.json(); } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const { field, value: rawValue } = body;
  if (!field || !PATCHABLE.has(field)) {
    return json({ ok: false, error: `Field "${field}" is not editable` }, 400);
  }

  const doc = await one(env.DB, 'SELECT * FROM documents WHERE id = ?', [docId]);
  if (!doc) return json({ ok: false, error: 'Not found' }, 404);

  const newValue = (typeof rawValue === 'string' ? rawValue.trim() : rawValue) || null;
  if (field === 'title' && !newValue) {
    return json({ ok: false, error: 'Title cannot be empty' }, 400);
  }

  const ts = now();
  const changes = {};
  if (doc[field] !== newValue) {
    changes[field] = { from: doc[field], to: newValue };
  }

  await batch(env.DB, [
    stmt(env.DB,
      `UPDATE documents SET ${field} = ?, updated_at = ? WHERE id = ?`,
      [newValue, ts, docId]),
    auditStmt(env.DB, {
      entityType: 'document',
      entityId: docId,
      eventType: 'updated',
      user,
      summary: `Updated document ${field}: ${doc.title}`,
      changes,
    }),
  ]);

  return json({ ok: true, field, value: newValue });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
