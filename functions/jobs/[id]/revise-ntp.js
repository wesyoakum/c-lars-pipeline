// functions/jobs/[id]/revise-ntp.js
//
// POST /jobs/:id/revise-ntp — EPS only.
//
// Mirrors revise-oc. Bumps ntp_revision and clears ntp_issued_at so
// the NTP page returns to its draft state for re-issue. The previous
// NTP PDF stays in the documents history.

import { one, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { now } from '../../lib/ids.js';
import { redirectWithFlash } from '../../lib/http.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const jobId = params.id;

  const job = await one(env.DB, 'SELECT * FROM jobs WHERE id = ?', [jobId]);
  if (!job) return redirectWithFlash('/jobs', 'Job not found.', 'error');

  if (!(job.job_type || '').split(',').includes('eps')) {
    return redirectWithFlash(
      `/jobs/${jobId}/ntp`,
      'NTP is only applicable to EPS jobs.',
      'error'
    );
  }
  if (!job.ntp_issued_at) {
    return redirectWithFlash(
      `/jobs/${jobId}/ntp`,
      'No issued NTP to revise.',
      'error'
    );
  }

  const ts = now();
  const newRev = (job.ntp_revision || 1) + 1;

  await batch(env.DB, [
    stmt(env.DB,
      `UPDATE jobs
          SET ntp_issued_at = NULL,
              ntp_issued_by_user_id = NULL,
              ntp_revision = ?,
              updated_at = ?
        WHERE id = ?`,
      [newRev, ts, jobId]),
    auditStmt(env.DB, {
      entityType: 'job',
      entityId: jobId,
      eventType: 'ntp_revised',
      user,
      summary: `NTP ${job.ntp_number || ''} revised — bumped to revision ${newRev} for re-issue`,
      changes: {
        ntp_revision: { from: job.ntp_revision, to: newRev },
        ntp_issued_at: { from: job.ntp_issued_at, to: null },
      },
    }),
  ]);

  return redirectWithFlash(
    `/jobs/${jobId}/ntp`,
    `NTP moved to revision ${newRev}. Edit and re-issue to send the updated copy.`
  );
}
