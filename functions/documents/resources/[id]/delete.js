// functions/documents/resources/[id]/delete.js
//
// POST /documents/resources/:id/delete — Delete a resource from R2 + D1.

import { one, stmt, batch } from '../../../lib/db.js';
import { auditStmt } from '../../../lib/audit.js';
import { deleteFromR2 } from '../../../lib/r2.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const resourceId = params.id;

  const resource = await one(
    env.DB,
    `SELECT id, title, r2_key FROM resources WHERE id = ?`,
    [resourceId]
  );

  if (!resource) {
    return redirect('Resource not found.', 'error');
  }

  // Delete from R2
  try {
    await deleteFromR2(env.DOCS, resource.r2_key);
  } catch {
    // R2 key may already be gone — continue with D1 cleanup
  }

  // Delete from D1
  await batch(env.DB, [
    stmt(env.DB, `DELETE FROM resources WHERE id = ?`, [resourceId]),
    auditStmt(env.DB, {
      entityType: 'resource',
      entityId: resourceId,
      eventType: 'deleted',
      user,
      summary: `Deleted resource: ${resource.title}`,
    }),
  ]);

  return redirect(`Deleted: ${resource.title}`);
}

function redirect(message, level = 'success') {
  const url = `/documents/resources?flash=${encodeURIComponent(message)}&flash_level=${level}`;
  return Response.redirect(url, 303);
}
