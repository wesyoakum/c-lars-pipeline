// functions/jobs/[id]/record-authorization.js
//
// POST /jobs/:id/record-authorization — EPS only.
// Records customer Authorization to Proceed + optional CEO/CFO concurrence.
// Status: awaiting_authorization → awaiting_ntp.

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
    return redirectWithFlash(`/jobs/${jobId}`, 'Authorization is only applicable to EPS jobs.', 'error');
  }
  if (job.status !== 'awaiting_authorization') {
    return redirectWithFlash(`/jobs/${jobId}`, 'Job is not awaiting authorization.', 'error');
  }

  const input = await formBody(request);
  const ts = now();
  const authNotes = (input.authorization_notes || '').trim() || null;
  const ceoConcurrenceBy = (input.ceo_concurrence_by || '').trim() || null;
  const cfoConcurrenceBy = (input.cfo_concurrence_by || '').trim() || null;

  const stmts = [
    stmt(env.DB,
      `UPDATE jobs
          SET authorization_received_at = ?, authorization_notes = ?,
              ceo_concurrence_at = ?, ceo_concurrence_by = ?,
              cfo_concurrence_at = ?, cfo_concurrence_by = ?,
              status = 'awaiting_ntp', updated_at = ?
        WHERE id = ?`,
      [
        ts, authNotes,
        ceoConcurrenceBy ? ts : null, ceoConcurrenceBy,
        cfoConcurrenceBy ? ts : null, cfoConcurrenceBy,
        ts, jobId,
      ]),
    auditStmt(env.DB, {
      entityType: 'job',
      entityId: jobId,
      eventType: 'authorization_received',
      user,
      summary: `Customer authorization received${ceoConcurrenceBy ? `, CEO concurrence: ${ceoConcurrenceBy}` : ''}${cfoConcurrenceBy ? `, CFO concurrence: ${cfoConcurrenceBy}` : ''}`,
      changes: {
        status: { from: 'awaiting_authorization', to: 'awaiting_ntp' },
        authorization_notes: { from: null, to: authNotes },
      },
    }),
  ];

  await batch(env.DB, stmts);

  return redirectWithFlash(`/jobs/${jobId}`, 'Authorization recorded — awaiting NTP issuance.');
}
