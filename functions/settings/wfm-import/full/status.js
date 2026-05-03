// functions/settings/wfm-import/full/status.js
//
// GET /settings/wfm-import/full/status
//
// Read-only progress poll for the full-import run. Returns the
// current run state plus per-kind plan counts. Polled by the
// workbench page every few seconds while a run is in progress.
//
// Admin only.

import { hasRole } from '../../../lib/auth.js';
import { one, all } from '../../../lib/db.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function safeParse(s, fallback) {
  if (s == null || s === '') return fallback;
  try { return JSON.parse(s); }
  catch { return fallback; }
}

export async function onRequestGet(context) {
  const { env, data } = context;
  const user = data?.user;
  if (!user) return json({ ok: false, error: 'sign_in_required' }, 401);
  if (!hasRole(user, 'admin')) return json({ ok: false, error: 'admin_only' }, 403);

  // Find the latest full-import run (in_progress preferred; fall back
  // to most-recent any-status so the page can show "last completed
  // run" even when nothing is running now).
  let run = await one(env.DB,
    `SELECT id, started_at, finished_at, triggered_by, status, summary,
            counts_json, errors_json, links_json, total_planned,
            options_json, updated_at
       FROM wfm_import_runs
      WHERE mode = 'full' AND status = 'in_progress'
      ORDER BY started_at DESC LIMIT 1`);

  if (!run) {
    run = await one(env.DB,
      `SELECT id, started_at, finished_at, triggered_by, status, summary,
              counts_json, errors_json, links_json, total_planned,
              options_json, updated_at
         FROM wfm_import_runs
        WHERE mode = 'full'
        ORDER BY started_at DESC LIMIT 1`);
  }

  if (!run) {
    return json({ ok: true, run: null });
  }

  // Per-kind plan counts, grouped by status. Lets the UI render
  // "staff: 12 / 12 done · clients: 47 / 158 done · leads: 0 / 78 pending …"
  const planCounts = await all(env.DB,
    `SELECT kind, status, COUNT(*) AS n
       FROM wfm_import_plans
      WHERE run_id = ?
      GROUP BY kind, status`,
    [run.id]);

  // Pivot into { kind: { pending, processing, done, error, cancelled, total } }
  const KINDS = ['staff', 'client', 'lead', 'quote', 'job'];
  const byKind = {};
  for (const k of KINDS) byKind[k] = { pending: 0, processing: 0, done: 0, error: 0, cancelled: 0, total: 0 };
  for (const r of planCounts) {
    if (!byKind[r.kind]) byKind[r.kind] = { pending: 0, processing: 0, done: 0, error: 0, cancelled: 0, total: 0 };
    byKind[r.kind][r.status] = r.n;
    byKind[r.kind].total += r.n;
  }

  const totalDone = Object.values(byKind).reduce((s, v) => s + v.done, 0);
  const totalErrored = Object.values(byKind).reduce((s, v) => s + v.error, 0);
  const totalPending = Object.values(byKind).reduce((s, v) => s + v.pending + v.processing, 0);
  const totalAll = run.total_planned || (totalDone + totalErrored + totalPending);

  return json({
    ok: true,
    run: {
      id: run.id,
      status: run.status,
      started_at: run.started_at,
      finished_at: run.finished_at,
      updated_at: run.updated_at,
      triggered_by: run.triggered_by,
      summary: run.summary,
      counts: safeParse(run.counts_json, {}),
      errors: safeParse(run.errors_json, []),
      links: safeParse(run.links_json, []),
      total_planned: totalAll,
      options: safeParse(run.options_json, {}),
    },
    progress: {
      total: totalAll,
      done: totalDone,
      pending: totalPending,
      errored: totalErrored,
      percent: totalAll > 0 ? Math.round(100 * totalDone / totalAll) : 0,
      by_kind: byKind,
    },
  });
}
