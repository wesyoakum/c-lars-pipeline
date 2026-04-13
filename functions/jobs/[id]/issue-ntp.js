// functions/jobs/[id]/issue-ntp.js
//
// POST /jobs/:id/issue-ntp — EPS only.
// Issues Notice to Proceed. Status: awaiting_ntp → handed_off.

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

  if (job.job_type !== 'eps') {
    return redirectWithFlash(`/jobs/${jobId}`, 'NTP is only applicable to EPS jobs.', 'error');
  }
  if (job.status !== 'awaiting_ntp') {
    return redirectWithFlash(`/jobs/${jobId}`, 'Job is not awaiting NTP.', 'error');
  }

  const ts = now();

  await batch(env.DB, [
    stmt(env.DB,
      `UPDATE jobs
          SET ntp_issued_at = ?, ntp_issued_by_user_id = ?,
              status = 'handed_off',
              handed_off_at = ?, handed_off_by_user_id = ?,
              updated_at = ?
        WHERE id = ?`,
      [ts, user?.id, ts, user?.id, ts, jobId]),
    auditStmt(env.DB, {
      entityType: 'job',
      entityId: jobId,
      eventType: 'ntp_issued',
      user,
      summary: `NTP issued — job handed off`,
      changes: {
        status: { from: 'awaiting_ntp', to: 'handed_off' },
      },
    }),
  ]);

  return redirectWithFlash(`/jobs/${jobId}`, 'NTP issued — job handed off.');
}
