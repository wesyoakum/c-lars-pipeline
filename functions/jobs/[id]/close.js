// functions/jobs/[id]/close.js
//
// POST /jobs/:id/close — Close a job.

import { one, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { now } from '../../lib/ids.js';
import { redirectWithFlash, formBody } from '../../lib/http.js';

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const jobId = params.id;

  const job = await one(env.DB, 'SELECT * FROM jobs WHERE id = ?', [jobId]);
  if (!job) return redirectWithFlash('/jobs', 'Job not found.', 'error');

  if (job.status === 'handed_off' || job.status === 'cancelled') {
    return redirectWithFlash(`/jobs/${jobId}`, 'Cannot close a job that is already handed off or closed.', 'error');
  }

  const input = await formBody(request);
  const ts = now();
  const reason = (input.reason || '').trim() || null;

  await batch(env.DB, [
    stmt(env.DB,
      `UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ?`,
      [ts, jobId]),
    auditStmt(env.DB, {
      entityType: 'job',
      entityId: jobId,
      eventType: 'closed',
      user,
      summary: `Job closed${reason ? `: ${reason}` : ''}`,
      changes: {
        status: { from: job.status, to: 'cancelled' },
      },
    }),
  ]);

  return redirectWithFlash(`/jobs/${jobId}`, 'Job closed.');
}
