// functions/library/items/[id]/delete.js
//
// POST /library/items/:id/delete — remove a library item.

import { one, stmt, batch } from '../../../lib/db.js';
import { auditStmt } from '../../../lib/audit.js';
import { redirectWithFlash } from '../../../lib/http.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const id = params.id;

  const before = await one(
    env.DB,
    'SELECT id, name, description, default_unit, default_price, category FROM items_library WHERE id = ?',
    [id]
  );
  if (!before) return new Response('Library item not found', { status: 404 });

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

  return redirectWithFlash('/library/items', `Deleted "${before.name}".`);
}
