// functions/settings/rerun-extractions/retry-wfm.js
//
// POST /settings/rerun-extractions/retry-wfm
//
// Re-queues one wfm_import_plans row that failed (status='error') and
// nudges the cron pipeline forward so the operator sees the result on
// the next page load instead of waiting up to a minute for the next
// scheduled tick.
//
// Steps:
//   1. Flip plan.status from 'error' → 'pending' and clear error_message.
//   2. If the parent wfm_import_runs row has settled to 'completed',
//      reopen it ('in_progress') so runOneStep() will see it as work.
//   3. Call runOneStep(env) once, synchronously. It picks the next
//      pending plan from the oldest in-progress run, which will
//      include our just-flipped row.

import { one, run as dbRun } from '../../lib/db.js';
import { redirectWithFlash, formBody } from '../../lib/http.js';
import { hasRole } from '../../lib/auth.js';
import { now } from '../../lib/ids.js';
import { runOneStep } from '../../api/cron/wfm-step.js';

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user || !hasRole(user, 'admin')) {
    return redirectWithFlash('/settings/rerun-extractions', 'Admin only.', 'error');
  }

  const input = await formBody(request);
  const id = String(input.id || '').trim();
  if (!id) {
    return redirectWithFlash('/settings/rerun-extractions', 'Missing id.', 'error');
  }

  const plan = await one(env.DB,
    `SELECT id, run_id, kind, status FROM wfm_import_plans WHERE id = ?`,
    [id]);
  if (!plan) {
    return redirectWithFlash('/settings/rerun-extractions',
      `Plan ${id.slice(0, 8)} not found.`, 'error');
  }
  if (plan.status !== 'error') {
    return redirectWithFlash('/settings/rerun-extractions',
      `Plan ${id.slice(0, 8)} is not in error state (current: ${plan.status}).`, 'warn');
  }

  const ts = now();

  await dbRun(env.DB,
    `UPDATE wfm_import_plans
        SET status = 'pending',
            error_message = NULL,
            started_at = NULL,
            finished_at = NULL,
            updated_at = ?
      WHERE id = ? AND status = 'error'`,
    [ts, id]);

  await dbRun(env.DB,
    `UPDATE wfm_import_runs
        SET status = 'in_progress',
            finished_at = NULL,
            updated_at = ?
      WHERE id = ? AND status = 'completed'`,
    [ts, plan.run_id]);

  // Synchronously advance the cron once so the user sees progress on
  // page reload. The next scheduled cron tick (within ~1 minute) will
  // pick up anything we didn't finish in this single call.
  try {
    await runOneStep(env);
  } catch (e) {
    return redirectWithFlash(
      '/settings/rerun-extractions',
      `Re-queued plan ${id.slice(0, 8)} but the immediate run step errored: ${e?.message || 'unknown'}. Cron will retry within a minute.`,
      'warn'
    );
  }

  return redirectWithFlash('/settings/rerun-extractions',
    `Re-queued ${plan.kind} plan ${id.slice(0, 8)} and advanced the queue.`);
}
