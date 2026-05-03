// functions/settings/wfm-import/full/cancel.js
//
// POST /settings/wfm-import/full/cancel
//
// Aborts the in-progress full-import run. Marks remaining pending /
// processing plan rows as 'cancelled' and the run row as 'cancelled'.
// Already-imported records stay in Pipeline (idempotent — restarting
// the run skips them).
//
// Admin only.

import { hasRole } from '../../../lib/auth.js';
import { one, run } from '../../../lib/db.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function nowIso() { return new Date().toISOString(); }

export async function onRequestPost(context) {
  const { env, data } = context;
  const user = data?.user;
  if (!user) return json({ ok: false, error: 'sign_in_required' }, 401);
  if (!hasRole(user, 'admin')) return json({ ok: false, error: 'admin_only' }, 403);

  const runRow = await one(env.DB,
    `SELECT id FROM wfm_import_runs
      WHERE mode = 'full' AND status = 'in_progress'
      ORDER BY started_at DESC LIMIT 1`);
  if (!runRow) {
    return json({ ok: false, error: 'no_in_progress_run' }, 404);
  }

  const ts = nowIso();

  // Mark pending/processing plans as cancelled. Already-done plans
  // stay 'done' — the records they imported remain in Pipeline.
  await run(env.DB,
    `UPDATE wfm_import_plans
        SET status = 'cancelled', updated_at = ?
      WHERE run_id = ? AND status IN ('pending', 'processing')`,
    [ts, runRow.id]);

  await run(env.DB,
    `UPDATE wfm_import_runs
        SET status = 'cancelled', finished_at = ?, updated_at = ?
      WHERE id = ?`,
    [ts, ts, runRow.id]);

  return json({ ok: true, run_id: runRow.id, message: 'Cancelled. Already-imported records remain in Pipeline.' });
}
