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

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const id = params.id;

  const before = await one(
    env.DB,
    'SELECT id, description FROM labor_items WHERE id = ?',
    [id]
  );
  if (!before) return new Response('Labor item not found', { status: 404 });

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

  return redirectWithFlash('/library/labor-items', `Deleted "${before.description}".`);
}
