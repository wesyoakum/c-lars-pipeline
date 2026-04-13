// functions/jobs/[id]/amend-oc.js
//
// POST /jobs/:id/amend-oc — Refurb only.
// Increments oc_revision after a supplemental quote is accepted.
// Job stays in handed_off status.

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

  if (!(job.job_type || '').split(',').includes('refurb')) {
    return redirectWithFlash(`/jobs/${jobId}`, 'OC amendments are only applicable to refurb jobs.', 'error');
  }
  if (job.status !== 'handed_off') {
    return redirectWithFlash(`/jobs/${jobId}`, 'OC can only be amended after hand-off.', 'error');
  }

  const input = await formBody(request);
  const ts = now();
  const newOcNumber = (input.oc_number || '').trim() || job.oc_number;
  const notes = (input.notes || '').trim() || null;
  const newRev = job.oc_revision + 1;

  await batch(env.DB, [
    stmt(env.DB,
      `UPDATE jobs
          SET oc_number = ?, oc_revision = ?, oc_issued_at = ?,
              oc_issued_by_user_id = ?, updated_at = ?
        WHERE id = ?`,
      [newOcNumber, newRev, ts, user?.id, ts, jobId]),
    auditStmt(env.DB, {
      entityType: 'job',
      entityId: jobId,
      eventType: 'amended_oc_issued',
      user,
      summary: `Amended OC Rev ${newRev}: ${newOcNumber}${notes ? ` — ${notes}` : ''}`,
      changes: {
        oc_revision: { from: job.oc_revision, to: newRev },
        oc_number: { from: job.oc_number, to: newOcNumber },
      },
    }),
  ]);

  return redirectWithFlash(`/jobs/${jobId}`, `OC amended to Rev ${newRev}.`);
}
