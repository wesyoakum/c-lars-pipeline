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
    'SELECT id, name, description FROM builds_library WHERE id = ?',
    [id]
  );
  if (!before) {
    if (json) return jsonResponse({ ok: false, error: 'Build template not found' }, 404);
    return new Response('Build template not found', { status: 404 });
  }

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

  if (json) return jsonResponse({ ok: true, id });
  return redirectWithFlash('/library/builds', `Deleted "${before.name}".`);
}
