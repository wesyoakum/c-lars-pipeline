// functions/jobs/[id]/change-orders/[coId]/cancel.js
//
// POST /jobs/:id/change-orders/:coId/cancel — cancel an in-flight
// change order. Flips change_orders.status to 'cancelled' and returns
// the opp to job_in_progress so the user can start a fresh CO or
// continue the baseline work. Any draft/issued quotes on this CO are
// left in place (historical record), but the user's intent here is
// "stop this CO cycle".

import { one, stmt, batch } from '../../../../lib/db.js';
import { auditStmt } from '../../../../lib/audit.js';
import { now } from '../../../../lib/ids.js';
import { redirectWithFlash, formBody } from '../../../../lib/http.js';
import { changeOppStage } from '../../../../lib/stage-transitions.js';

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const jobId = params.id;
  const coId = params.coId;

  const co = await one(
    env.DB,
    'SELECT id, number, status, opportunity_id FROM change_orders WHERE id = ? AND job_id = ?',
    [coId, jobId]
  );
  if (!co) return redirectWithFlash(`/jobs/${jobId}`, 'CO not found.', 'error');
  if (co.status === 'cancelled' || co.status === 'won') {
    return redirectWithFlash(
      `/jobs/${jobId}/change-orders/${coId}`,
      `Cannot cancel a ${co.status} change order.`,
      'error'
    );
  }

  const input = await formBody(request);
  const reason = (input.reason || '').trim() || null;
  const ts = now();

  await batch(env.DB, [
    stmt(env.DB,
      `UPDATE change_orders SET status = 'cancelled', updated_at = ? WHERE id = ?`,
      [ts, coId]),
    auditStmt(env.DB, {
      entityType: 'change_order',
      entityId: coId,
      eventType: 'cancelled',
      user,
      summary: `Cancelled change order ${co.number}${reason ? ` — ${reason}` : ''}`,
      changes: { status: { from: co.status, to: 'cancelled' } },
      overrideReason: reason,
    }),
  ]);

  if (co.opportunity_id) {
    await changeOppStage(context, co.opportunity_id, 'job_in_progress', {
      reason: `CO ${co.number} cancelled`,
    });
  }

  return redirectWithFlash(`/jobs/${jobId}`, `Cancelled change order ${co.number}.`);
}
