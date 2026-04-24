// functions/jobs/[id]/change-orders/index.js
//
// POST /jobs/:id/change-orders — create a new Change Order on this job.
//
// Allocates a CO number (CO-YYYY-NNNN), inserts a change_orders row
// with status='drafted', flips opportunities.change_order = 1 so the
// CO loop stages appear in the picker, and advances the opp to
// change_order_drafted.
//
// Redirects to the CO detail page so the user can draft a CO quote.

import { one, stmt, batch } from '../../../lib/db.js';
import { auditStmt } from '../../../lib/audit.js';
import { uuid, now, nextNumber, currentYear } from '../../../lib/ids.js';
import { redirectWithFlash, formBody } from '../../../lib/http.js';
import { changeOppStage } from '../../../lib/stage-transitions.js';

export async function onRequestGet(context) {
  // List view lives on the job detail page — redirect there.
  const jobId = context.params.id;
  return Response.redirect(
    new URL(`/jobs/${jobId}`, context.request.url),
    302
  );
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const jobId = params.id;

  const job = await one(env.DB, 'SELECT * FROM jobs WHERE id = ?', [jobId]);
  if (!job) return redirectWithFlash('/jobs', 'Job not found.', 'error');

  if (!job.opportunity_id) {
    return redirectWithFlash(
      `/jobs/${jobId}`,
      'Change orders require a linked opportunity.',
      'error'
    );
  }
  if (job.status === 'cancelled' || job.status === 'complete') {
    return redirectWithFlash(
      `/jobs/${jobId}`,
      `Cannot create a change order on a ${job.status} job.`,
      'error'
    );
  }

  const input = await formBody(request);
  const description = (input.description || '').trim() || null;

  // Sequence = (existing COs on this job) + 1.
  const prior = await one(
    env.DB,
    'SELECT COUNT(*) AS n FROM change_orders WHERE job_id = ?',
    [jobId]
  );
  const sequence = Number(prior?.n || 0) + 1;

  const coId = uuid();
  const number = await nextNumber(env.DB, `CO-${currentYear()}`);
  const ts = now();

  await batch(env.DB, [
    stmt(env.DB,
      `INSERT INTO change_orders
         (id, number, opportunity_id, job_id, sequence, status,
          description, amended_oc_revision,
          created_at, updated_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, 'drafted', ?, 1, ?, ?, ?)`,
      [coId, number, job.opportunity_id, jobId, sequence, description, ts, ts, user?.id ?? null]),
    stmt(env.DB,
      `UPDATE opportunities SET change_order = 1, updated_at = ? WHERE id = ?`,
      [ts, job.opportunity_id]),
    auditStmt(env.DB, {
      entityType: 'change_order',
      entityId: coId,
      eventType: 'created',
      user,
      summary: `Created change order ${number} on ${job.number}`,
      changes: {
        job_id: jobId,
        opportunity_id: job.opportunity_id,
        sequence,
      },
    }),
  ]);

  // Advance opp to change_order_drafted. onlyForward keeps us from
  // regressing an opp that's already further along.
  await changeOppStage(context, job.opportunity_id, 'change_order_drafted', {
    reason: `Change order ${number} drafted`,
    onlyForward: true,
  });

  return redirectWithFlash(
    `/jobs/${jobId}/change-orders/${coId}`,
    `Created change order ${number}.`
  );
}
