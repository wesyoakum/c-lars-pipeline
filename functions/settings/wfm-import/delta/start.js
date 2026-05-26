// functions/settings/wfm-import/delta/start.js
//
// POST /settings/wfm-import/delta/start
//
// Step 1 of "Check for changes" — creates run + snapshot rows and
// returns IDs. The browser then orchestrates:
//   POST /delta/fetch  ×4 (one per kind, writes to R2)
//   POST /delta/diff-run   (reads R2, diffs against Pipeline)
//
// This keeps each request well under the 30s timeout.
//
// Admin-only.

import { hasRole } from '../../../lib/auth.js';
import { one, run } from '../../../lib/db.js';
import {
  createSnapshotRow, latestCompleteSnapshot,
} from '../../../lib/wfm-snapshot.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function nowIso() { return new Date().toISOString(); }
function newId()  { return crypto.randomUUID(); }

export async function onRequestPost(context) {
  const { env, data } = context;
  const user = data?.user;
  if (!user) return json({ ok: false, error: 'sign_in_required' }, 401);
  if (!hasRole(user, 'admin')) return json({ ok: false, error: 'admin_only' }, 403);

  // Refuse if any import is already running.
  const existing = await one(env.DB,
    `SELECT id, mode FROM wfm_import_runs
      WHERE mode IN ('full', 'delta', 'delta-review') AND status = 'in_progress'
      ORDER BY started_at DESC LIMIT 1`);
  if (existing) {
    return json({
      ok: false,
      error: 'already_in_progress',
      run_id: existing.id,
      mode: existing.mode,
      message: `A ${existing.mode} import is already running. Cancel it first or wait for it to finish.`,
    }, 409);
  }

  const startedAt = nowIso();
  const runId = newId();
  const snapshotId = newId();

  // Create run row.
  await run(env.DB,
    `INSERT INTO wfm_import_runs
       (id, started_at, finished_at, triggered_by, ok, summary,
        counts_json, errors_json, links_json,
        selection_summary_json, selection_size,
        mode, status, options_json, total_planned)
     VALUES (?, ?, NULL, ?, 0, 'Checking for changes…',
             '{}', '[]', '[]', '[]', 0,
             'delta-review', 'in_progress', '{}', 0)`,
    [runId, startedAt, user.email || '']);

  // Create snapshot row.
  const prevSnapshot = await latestCompleteSnapshot(env.DB);
  await createSnapshotRow(env.DB, {
    id: snapshotId,
    createdBy: user.email,
    parentId: prevSnapshot?.id || null,
  });

  return json({
    ok: true,
    run_id: runId,
    snapshot_id: snapshotId,
    status: 'created',
    message: 'Run created. Fetch each kind next.',
  });
}
