// functions/documents/resources/[id]/patch.js
//
// POST /documents/resources/:id/patch — inline field save (JSON).
// Accepts { field, value } and updates title or category.

import { one, stmt, batch } from '../../../lib/db.js';
import { auditStmt } from '../../../lib/audit.js';

const PATCHABLE = new Set(['title', 'category']);

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const resourceId = params.id;

  let body;
  try { body = await request.json(); } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const { field, value: rawValue } = body;
  if (!field || !PATCHABLE.has(field)) {
    return json({ ok: false, error: `Field "${field}" is not editable` }, 400);
  }

  const resource = await one(env.DB, 'SELECT * FROM resources WHERE id = ?', [resourceId]);
  if (!resource) return json({ ok: false, error: 'Not found' }, 404);

  const newValue = (typeof rawValue === 'string' ? rawValue.trim() : rawValue) || null;
  if (field === 'title' && !newValue) {
    return json({ ok: false, error: 'Title cannot be empty' }, 400);
  }

  const changes = {};
  if (resource[field] !== newValue) {
    changes[field] = { from: resource[field], to: newValue };
  }

  await batch(env.DB, [
    stmt(env.DB, `UPDATE resources SET ${field} = ? WHERE id = ?`, [newValue, resourceId]),
    auditStmt(env.DB, {
      entityType: 'resource',
      entityId: resourceId,
      eventType: 'updated',
      user,
      summary: `Updated resource ${field}: ${resource.title}`,
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
