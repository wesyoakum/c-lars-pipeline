// functions/library/builds/[id]/delete.js
//
// POST /library/builds/:id/delete — remove a build template.
//
// Cascades: deletes builds_library_dm_selections,
// builds_library_labor_selections, and builds_library_labor rows
// for this build.

import { one, stmt, batch } from '../../../lib/db.js';
import { auditStmt } from '../../../lib/audit.js';
import { redirectWithFlash } from '../../../lib/http.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const id = params.id;

  const before = await one(
    env.DB,
    'SELECT id, name, description FROM builds_library WHERE id = ?',
    [id]
  );
  if (!before) return new Response('Build template not found', { status: 404 });

  await batch(env.DB, [
    stmt(env.DB, 'DELETE FROM builds_library_dm_selections WHERE builds_library_id = ?', [id]),
    stmt(env.DB, 'DELETE FROM builds_library_labor_selections WHERE builds_library_id = ?', [id]),
    stmt(env.DB, 'DELETE FROM builds_library_labor WHERE builds_library_id = ?', [id]),
    stmt(env.DB, 'DELETE FROM builds_library WHERE id = ?', [id]),
    auditStmt(env.DB, {
      entityType: 'builds_library',
      entityId: id,
      eventType: 'deleted',
      user,
      summary: `Deleted build template "${before.name}"`,
      changes: before,
    }),
  ]);

  return redirectWithFlash('/library/builds', `Deleted "${before.name}".`);
}
