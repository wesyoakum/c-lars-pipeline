// functions/settings/auto-tasks/[id]/delete.js
//
// POST /settings/auto-tasks/:id/delete — remove a rule.
//
// ON DELETE CASCADE on task_rule_fires means the fire history goes
// away with the rule. Activities created by this rule keep their row
// but lose their source_rule_id link (ON DELETE SET NULL).

import { one, stmt, batch } from '../../../lib/db.js';
import { auditStmt } from '../../../lib/audit.js';
import { redirectWithFlash } from '../../../lib/http.js';
import { hasRole } from '../../../lib/auth.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const id = params.id;

  if (!hasRole(user, 'admin')) {
    return new Response('Admin role required', { status: 403 });
  }

  const before = await one(
    env.DB,
    'SELECT id, name, trigger, description FROM task_rules WHERE id = ?',
    [id]
  );
  if (!before) return new Response('Rule not found', { status: 404 });

  await batch(env.DB, [
    stmt(env.DB, 'DELETE FROM task_rules WHERE id = ?', [id]),
    auditStmt(env.DB, {
      entityType: 'task_rule',
      entityId: id,
      eventType: 'deleted',
      user,
      summary: `Deleted auto-task rule "${before.name}"`,
      changes: before,
    }),
  ]);

  return redirectWithFlash(
    '/settings/auto-tasks',
    `Deleted rule "${before.name}".`
  );
}
