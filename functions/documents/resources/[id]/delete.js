// functions/documents/resources/[id]/delete.js
//
// POST /documents/resources/:id/delete — Soft-delete a resource.
// R2 files are left in place (only purged on hard-delete or expiry sweep).

import { one, batch } from '../../../lib/db.js';
import { auditStmt } from '../../../lib/audit.js';
import { softDeleteStmt } from '../../../lib/soft-delete.js';
import { now } from '../../../lib/ids.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const resourceId = params.id;

  const resource = await one(
    env.DB,
    `SELECT id, title, r2_key FROM resources WHERE id = ? AND deleted_at IS NULL`,
    [resourceId]
  );

  if (!resource) {
    return redirect('Resource not found.', 'error');
  }

  const ts = now();
  await batch(env.DB, [
    softDeleteStmt(env.DB, 'resources', resourceId, ts),
    auditStmt(env.DB, {
      entityType: 'resource',
      entityId: resourceId,
      eventType: 'deleted',
      user,
      summary: `Deleted resource: ${resource.title}`,
    }),
  ]);

  return redirect(`Deleted: ${resource.title}`, 'success', resourceId);
}

function redirect(message, level = 'success', id) {
  let url = `/documents/resources?flash=${encodeURIComponent(message)}&flash_level=${level}`;
  if (id) url += `&undo=${encodeURIComponent(`/documents/resources/${id}/restore`)}`;
  return new Response(null, { status: 303, headers: { Location: url } });
}
