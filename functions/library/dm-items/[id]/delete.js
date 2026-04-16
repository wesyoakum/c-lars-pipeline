// functions/library/dm-items/[id]/delete.js
//
// POST /library/dm-items/:id/delete — remove a DM item.
//
// We rely on cost_build_dm_selections.dm_item_id ON DELETE CASCADE to
// clean up any cost-build linkages automatically.

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
    'SELECT id, description, cost FROM dm_items WHERE id = ?',
    [id]
  );
  if (!before) {
    if (json) return jsonResponse({ ok: false, error: 'DM item not found' }, 404);
    return new Response('DM item not found', { status: 404 });
  }

  await batch(env.DB, [
    stmt(env.DB, 'DELETE FROM dm_items WHERE id = ?', [id]),
    auditStmt(env.DB, {
      entityType: 'dm_item',
      entityId: id,
      eventType: 'deleted',
      user,
      summary: `Deleted DM item "${before.description}"`,
      changes: before,
    }),
  ]);

  if (json) return jsonResponse({ ok: true, id });
  return redirectWithFlash('/library/dm-items', `Deleted "${before.description}".`);
}
