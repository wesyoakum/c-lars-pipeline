// functions/library/labor-items/[id]/delete.js
//
// POST /library/labor-items/:id/delete — remove a labor library item.
//
// labor_item_entries and cost_build_labor_selections both have
// ON DELETE CASCADE pointed at labor_items.id, so those tables clean
// themselves up.

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
    'SELECT id, description FROM labor_items WHERE id = ?',
    [id]
  );
  if (!before) {
    if (json) return jsonResponse({ ok: false, error: 'Labor item not found' }, 404);
    return new Response('Labor item not found', { status: 404 });
  }

  await batch(env.DB, [
    stmt(env.DB, 'DELETE FROM labor_items WHERE id = ?', [id]),
    auditStmt(env.DB, {
      entityType: 'labor_item',
      entityId: id,
      eventType: 'deleted',
      user,
      summary: `Deleted labor item "${before.description}"`,
      changes: before,
    }),
  ]);

  if (json) return jsonResponse({ ok: true, id });
  return redirectWithFlash('/library/labor-items', `Deleted "${before.description}".`);
}
