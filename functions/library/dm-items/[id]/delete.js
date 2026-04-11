// functions/library/dm-items/[id]/delete.js
//
// POST /library/dm-items/:id/delete — remove a DM item.
//
// We rely on cost_build_dm_selections.dm_item_id ON DELETE CASCADE to
// clean up any cost-build linkages automatically.

import { one, stmt, batch } from '../../../lib/db.js';
import { auditStmt } from '../../../lib/audit.js';
import { redirectWithFlash } from '../../../lib/http.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const id = params.id;

  const before = await one(
    env.DB,
    'SELECT id, description, cost FROM dm_items WHERE id = ?',
    [id]
  );
  if (!before) return new Response('DM item not found', { status: 404 });

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

  return redirectWithFlash('/library/dm-items', `Deleted "${before.description}".`);
}
