// functions/settings/wfm-import/delta/apply.js
//
// POST /settings/wfm-import/delta/apply
//
// Applies all approved pending items for a delta-review run.
// Mutates WFM payloads per field-level decisions, then calls
// processSamples() from commit.js to do the actual import.
//
// After success: marks rows 'applied', updates wfm_import_snapshots,
// closes the run.
//
// Admin-only.

import { hasRole } from '../../../lib/auth.js';
import { all, one, run, stmt, batch } from '../../../lib/db.js';
import { processSamples } from '../commit.js';
import { FIELD_MAPS } from './diff.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function nowIso() { return new Date().toISOString(); }

// Reverse-map: for a given entity type and pipeline column, return the
// WFM key that commit.js reads from the payload. Used to substitute
// Pipeline values back into the WFM payload for "keep Pipeline" fields.
function getWfmKey(entityType, pipelineCol) {
  const fields = FIELD_MAPS[entityType] || [];
  const field = fields.find(f => f.pipeline === pipelineCol);
  return field?.wfm || null; // null for derived fields (can't substitute)
}

// Apply per-field decisions: for fields where user chose 'pipeline',
// write the Pipeline value back into the WFM payload so processSamples()
// effectively no-ops on those fields.
function applyFieldDecisions(entityType, wfmPayload, pipelineSnapshot, decidedFields) {
  if (!decidedFields || !pipelineSnapshot) return wfmPayload;
  const mutated = { ...wfmPayload };
  for (const [pipelineCol, choice] of Object.entries(decidedFields)) {
    if (choice !== 'pipeline') continue;
    const wfmKey = getWfmKey(entityType, pipelineCol);
    if (wfmKey && pipelineCol in pipelineSnapshot) {
      mutated[wfmKey] = pipelineSnapshot[pipelineCol];
    }
  }
  return mutated;
}

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user || !hasRole(user, 'admin')) return json({ error: 'admin only' }, 403);

  let body = {};
  try { body = await request.json(); } catch { /* empty body OK */ }

  // Find the run to apply.
  let runId = body?.run_id;
  if (!runId) {
    const latest = await one(env.DB,
      `SELECT id FROM wfm_import_runs
        WHERE mode = 'delta-review' AND status = 'in_progress'
        ORDER BY started_at DESC LIMIT 1`);
    if (!latest) return json({ ok: false, error: 'No delta-review run in progress.' }, 404);
    runId = latest.id;
  }

  // Load approved items in small batches to stay within the 30s timeout.
  const batchSize = body?.batch_size || 30;
  const approved = await all(env.DB,
    `SELECT id, entity_type, external_id, action,
            wfm_payload_json, pipeline_snapshot_json,
            decided_fields_json
       FROM wfm_import_pending
      WHERE run_id = ? AND status = 'approved'
      ORDER BY
        CASE entity_type
          WHEN 'account' THEN 1
          WHEN 'opportunity' THEN 2
          WHEN 'quote' THEN 3
          WHEN 'job' THEN 4
          ELSE 5
        END,
        created_at
      LIMIT ?`,
    [runId, batchSize]);

  if (approved.length === 0) {
    return json({ ok: true, applied: 0, message: 'No approved items to apply.' });
  }

  // Build the samples object for processSamples().
  const samples = { clients: [], leads: [], quotes: [], jobs: [] };
  const entityToSamples = {
    account:     'clients',
    opportunity: 'leads',
    quote:       'quotes',
    job:         'jobs',
  };

  for (const row of approved) {
    let wfmPayload;
    try { wfmPayload = JSON.parse(row.wfm_payload_json); }
    catch { continue; }

    // Apply per-field decisions (substitute Pipeline values where user chose 'pipeline').
    let decidedFields = null;
    let pipelineSnapshot = null;
    try { decidedFields = row.decided_fields_json ? JSON.parse(row.decided_fields_json) : null; } catch { /* skip */ }
    try { pipelineSnapshot = row.pipeline_snapshot_json ? JSON.parse(row.pipeline_snapshot_json) : null; } catch { /* skip */ }

    if (decidedFields && pipelineSnapshot) {
      wfmPayload = applyFieldDecisions(row.entity_type, wfmPayload, pipelineSnapshot, decidedFields);
    }

    const key = entityToSamples[row.entity_type];
    if (key) samples[key].push(wfmPayload);
  }

  // Run the import engine.
  const ts = nowIso();
  let result;
  try {
    result = await processSamples(env, samples, { synth_orphan_quotes: true });
  } catch (err) {
    return json({
      ok: false,
      error: 'apply_failed',
      message: err?.message || String(err),
    }, 500);
  }

  // Mark approved rows as applied.
  const applyStmts = approved.map(row => stmt(env.DB,
    `UPDATE wfm_import_pending SET status = 'applied', applied_at = ? WHERE id = ?`,
    [ts, row.id]));
  for (let i = 0; i < applyStmts.length; i += 50) {
    await batch(env.DB, applyStmts.slice(i, i + 50));
  }

  // Update snapshots for applied records.
  const snapStmts = approved.map(row => stmt(env.DB,
    `INSERT OR REPLACE INTO wfm_import_snapshots
       (entity_type, external_id, payload_json, last_seen_at)
     VALUES (?, ?, ?, ?)`,
    [row.entity_type, row.external_id, row.wfm_payload_json, ts]));
  for (let i = 0; i < snapStmts.length; i += 50) {
    await batch(env.DB, snapStmts.slice(i, i + 50));
  }

  // Check if there are remaining pending items. If not, close the run.
  const remaining = await one(env.DB,
    `SELECT COUNT(*) AS cnt FROM wfm_import_pending
      WHERE run_id = ? AND status = 'pending'`,
    [runId]);
  if ((remaining?.cnt || 0) === 0) {
    await run(env.DB,
      `UPDATE wfm_import_runs
          SET status = 'completed', finished_at = ?, ok = 1,
              summary = 'Applied ' || ? || ' change(s).'
        WHERE id = ?`,
      [ts, String(approved.length), runId]);
  }

  return json({
    ok: true,
    applied: approved.length,
    counts: result.counts,
    errors: result.errors.length > 0 ? result.errors : undefined,
    remaining: remaining?.cnt || 0,
    message: `Applied ${approved.length} change(s). ${remaining?.cnt || 0} pending item(s) remain.`,
  });
}
