// functions/library/items/[id]/delete.js
//
// POST /library/items/:id/delete — remove a library item.

import { one, stmt, batch } from '../../../lib/db.js';
import { auditStmt } from '../../../lib/audit.js';
import { redirectWithFlash } from '../../../lib/http.js';

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
  const id = params.id;
  const json = wantsJson(request);

  const before = await one(
    env.DB,
    'SELECT id, name, description, default_unit, default_price, category FROM items_library WHERE id = ?',
    [id]
  );
  if (!before) {
    if (json) return jsonResponse({ ok: false, error: 'Library item not found' }, 404);
    return new Response('Library item not found', { status: 404 });
  }

  await batch(env.DB, [
    stmt(env.DB, 'DELETE FROM items_library WHERE id = ?', [id]),
    auditStmt(env.DB, {
      entityType: 'items_library',
      entityId: id,
      eventType: 'deleted',
      user,
      summary: `Deleted library item "${before.name}"`,
      changes: before,
    }),
  ]);

  if (json) return jsonResponse({ ok: true, id });
  return redirectWithFlash('/library/items', `Deleted "${before.name}".`);
}
