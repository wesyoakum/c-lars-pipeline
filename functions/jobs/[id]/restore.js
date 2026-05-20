// functions/jobs/[id]/restore.js
//
// POST /jobs/:id/restore — undo a soft-deleted job.
// Restores all children that share the same deleted_at timestamp.

import { one, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { restoreStmt, restoreChildrenStmt } from '../../lib/soft-delete.js';
import { redirectWithFlash } from '../../lib/http.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const jobId = params.id;

  const job = await one(
    env.DB,
    `SELECT id, number, title, deleted_at FROM jobs WHERE id = ? AND deleted_at IS NOT NULL`,
    [jobId]
  );
  if (!job) {
    return redirectWithFlash('/jobs', 'Job not found or not deleted.', 'error');
  }

  const ts = job.deleted_at;

  await batch(env.DB, [
    restoreChildrenStmt(env.DB, 'change_orders', 'job_id', jobId, ts),
    restoreChildrenStmt(env.DB, 'activities', 'job_id', jobId, ts),
    restoreChildrenStmt(env.DB, 'documents', 'job_id', jobId, ts),
    restoreChildrenStmt(env.DB, 'cost_builds', 'job_id', jobId, ts),
    restoreStmt(env.DB, 'jobs', jobId),
    auditStmt(env.DB, {
      entityType: 'job',
      entityId: jobId,
      eventType: 'restored',
      user,
      summary: `Restored job "${job.number || ''} \u00b7 ${job.title || ''}"`,
    }),
  ]);

  return redirectWithFlash(
    `/jobs/${jobId}`,
    `Restored job "${job.number || ''} \u00b7 ${job.title || ''}".`
  );
}
