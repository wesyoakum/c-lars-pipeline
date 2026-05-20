// functions/documents/resources/[id]/restore.js
//
// POST /documents/resources/:id/restore — undo a soft-deleted resource.

import { one, batch } from '../../../lib/db.js';
import { auditStmt } from '../../../lib/audit.js';
import { restoreStmt } from '../../../lib/soft-delete.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const resourceId = params.id;

  const resource = await one(
    env.DB,
    `SELECT id, title FROM resources WHERE id = ? AND deleted_at IS NOT NULL`,
    [resourceId]
  );
  if (!resource) {
    return redirect('Resource not found or not deleted.', 'error');
  }

  await batch(env.DB, [
    restoreStmt(env.DB, 'resources', resourceId),
    auditStmt(env.DB, {
      entityType: 'resource',
      entityId: resourceId,
      eventType: 'restored',
      user,
      summary: `Restored resource: ${resource.title}`,
    }),
  ]);

  return redirect(`Restored: ${resource.title}`);
}

function redirect(message, level = 'success') {
  const url = `/documents/resources?flash=${encodeURIComponent(message)}&flash_level=${level}`;
  return new Response(null, { status: 303, headers: { Location: url } });
}
