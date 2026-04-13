// functions/jobs/[id]/issue-oc.js
//
// POST /jobs/:id/issue-oc — Capture OC number and issue the Order Confirmation.
//
// For spares/service: status → handed_off (OC is the final step).
// For eps: status → awaiting_authorization (need customer auth before NTP).
// For refurb: status → handed_off (baseline OC).

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

  if (job.status !== 'created') {
    return redirectWithFlash(`/jobs/${jobId}`, 'OC can only be issued when job is in Created status.', 'error');
  }

  const input = await formBody(request);
  const ocNumber = (input.oc_number || '').trim();
  if (!ocNumber) {
    return redirectWithFlash(`/jobs/${jobId}`, 'OC number is required.', 'error');
  }

  const ts = now();
  const customerPo = (input.customer_po_number || '').trim() || job.customer_po_number;

  // Determine next status based on job type
  let newStatus;
  if (job.job_type === 'eps') {
    newStatus = 'awaiting_authorization';
  } else {
    // spares, refurb, service — OC means handed off
    newStatus = 'handed_off';
  }

  const stmts = [
    stmt(env.DB,
      `UPDATE jobs
          SET oc_number = ?, oc_issued_at = ?, oc_issued_by_user_id = ?,
              customer_po_number = ?, status = ?,
              ${newStatus === 'handed_off' ? 'handed_off_at = ?, handed_off_by_user_id = ?,' : ''}
              updated_at = ?
        WHERE id = ?`,
      [
        ocNumber, ts, user?.id,
        customerPo, newStatus,
        ...(newStatus === 'handed_off' ? [ts, user?.id] : []),
        ts, jobId,
      ]),
    auditStmt(env.DB, {
      entityType: 'job',
      entityId: jobId,
      eventType: 'oc_issued',
      user,
      summary: `OC issued: ${ocNumber} — status → ${newStatus}`,
      changes: {
        oc_number: { from: job.oc_number, to: ocNumber },
        status: { from: job.status, to: newStatus },
      },
    }),
  ];

  await batch(env.DB, stmts);

  const msg = newStatus === 'handed_off'
    ? `OC ${ocNumber} issued — job handed off.`
    : `OC ${ocNumber} issued — awaiting customer authorization.`;

  return redirectWithFlash(`/jobs/${jobId}`, msg);
}
