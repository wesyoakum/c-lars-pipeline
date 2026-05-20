// POST /opportunities/:id/restore
//
// Undo a soft-deleted opportunity. Restores all children that share
// the same deleted_at timestamp (cascade-deleted together).

import { one, all, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { restoreStmt, restoreChildrenStmt } from '../../lib/soft-delete.js';
import { redirectWithFlash } from '../../lib/http.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const oppId = params.id;

  const opp = await one(
    env.DB,
    `SELECT id, number, title, deleted_at FROM opportunities WHERE id = ? AND deleted_at IS NOT NULL`,
    [oppId]
  );
  if (!opp) {
    return redirectWithFlash('/opportunities', 'Opportunity not found or not deleted.', 'error');
  }

  const ts = opp.deleted_at;
  const statements = [];

  // Restore jobs that were cascade-deleted at the same timestamp,
  // plus their children.
  const jobs = await all(
    env.DB,
    `SELECT id FROM jobs WHERE opportunity_id = ? AND deleted_at = ?`,
    [oppId, ts]
  );
  for (const j of jobs) {
    statements.push(restoreChildrenStmt(env.DB, 'change_orders', 'job_id', j.id, ts));
    statements.push(restoreChildrenStmt(env.DB, 'activities', 'job_id', j.id, ts));
    statements.push(restoreChildrenStmt(env.DB, 'documents', 'job_id', j.id, ts));
    statements.push(restoreChildrenStmt(env.DB, 'cost_builds', 'job_id', j.id, ts));
    statements.push(restoreStmt(env.DB, 'jobs', j.id));
  }

  // Restore quote_lines via their parent quotes (quote_lines has
  // quote_id, not opportunity_id).
  const quotes = await all(
    env.DB,
    `SELECT id FROM quotes WHERE opportunity_id = ? AND deleted_at = ?`,
    [oppId, ts]
  );
  for (const q of quotes) {
    statements.push(restoreChildrenStmt(env.DB, 'quote_lines', 'quote_id', q.id, ts));
  }

  // Restore opp's direct children
  statements.push(restoreChildrenStmt(env.DB, 'quotes', 'opportunity_id', oppId, ts));
  statements.push(restoreChildrenStmt(env.DB, 'activities', 'opportunity_id', oppId, ts));
  statements.push(restoreChildrenStmt(env.DB, 'documents', 'opportunity_id', oppId, ts));
  statements.push(restoreChildrenStmt(env.DB, 'cost_builds', 'opportunity_id', oppId, ts));
  statements.push(restoreStmt(env.DB, 'opportunities', oppId));
  statements.push(auditStmt(env.DB, {
    entityType: 'opportunity',
    entityId: oppId,
    eventType: 'restored',
    user,
    summary: `Restored opportunity ${opp.number} (${opp.title || 'no title'})`,
  }));

  await batch(env.DB, statements);

  return redirectWithFlash(
    `/opportunities/${oppId}`,
    `Restored ${opp.number} (${opp.title || 'no title'}).`
  );
}
