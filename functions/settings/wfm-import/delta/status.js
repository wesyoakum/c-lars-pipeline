// functions/settings/wfm-import/delta/status.js
//
// GET /settings/wfm-import/delta/status?run_id=...
//
// Polls the status of a delta-review run. Used by the browser after
// delta/start returns { status: 'processing' }.

import { hasRole } from '../../../lib/auth.js';
import { one } from '../../../lib/db.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user || !hasRole(user, 'admin')) return json({ error: 'admin only' }, 403);

  const url = new URL(request.url);
  let runId = url.searchParams.get('run_id');
  if (!runId) return json({ error: 'run_id required' }, 400);

  // Support run_id=latest to find the most recent delta-review run.
  let r;
  if (runId === 'latest') {
    r = await one(env.DB,
      `SELECT id, status, summary, counts_json, total_planned, selection_size
         FROM wfm_import_runs WHERE mode = 'delta-review'
         ORDER BY started_at DESC LIMIT 1`);
  } else {
    r = await one(env.DB,
      `SELECT id, status, summary, counts_json, total_planned, selection_size
         FROM wfm_import_runs WHERE id = ?`, [runId]);
  }
  if (!r) return json({ error: 'not found' }, 404);

  // The run is "ready" when it has pending items (total_planned > 0)
  // or when it's completed with 0 changes.
  const ready = r.status === 'completed' || r.status === 'failed' || r.total_planned > 0;

  return json({
    ok: true,
    run_id: r.id,
    status: r.status,
    ready,
    summary: r.summary,
    total: r.total_planned,
    counts: r.counts_json ? JSON.parse(r.counts_json) : {},
  });
}
