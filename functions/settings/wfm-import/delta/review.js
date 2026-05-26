// functions/settings/wfm-import/delta/review.js
//
// GET  /settings/wfm-import/delta/review?run_id=<uuid>
//   Returns all pending items for a delta-review run with diffs.
//
// POST /settings/wfm-import/delta/review
//   Records approve / reject (dismiss) / skip decisions on pending items.
//
// Admin-only.

import { hasRole } from '../../../lib/auth.js';
import { all, one, run, stmt, batch } from '../../../lib/db.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function nowIso() { return new Date().toISOString(); }

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user || !hasRole(user, 'admin')) return json({ error: 'admin only' }, 403);

  const url = new URL(request.url);
  let runId = url.searchParams.get('run_id');

  // Default to latest delta-review run.
  if (!runId) {
    const latest = await one(env.DB,
      `SELECT id FROM wfm_import_runs
        WHERE mode = 'delta-review'
        ORDER BY started_at DESC LIMIT 1`);
    if (!latest) return json({ ok: true, items: [], summary: {} });
    runId = latest.id;
  }

  const items = await all(env.DB,
    `SELECT id, entity_type, external_id, action, pipeline_row_id,
            wfm_payload_json, pipeline_snapshot_json, fields_diff_json,
            status, decided_fields_json, created_at
       FROM wfm_import_pending
      WHERE run_id = ? AND status IN ('pending', 'approved')
      ORDER BY
        CASE entity_type
          WHEN 'account' THEN 1
          WHEN 'opportunity' THEN 2
          WHEN 'quote' THEN 3
          WHEN 'job' THEN 4
          ELSE 5
        END,
        created_at`,
    [runId]);

  // Load snapshot base payloads for raw WFM diff.
  const snapshotRows = await all(env.DB,
    'SELECT entity_type, external_id, payload_json FROM wfm_import_snapshots');
  const snapshotMap = new Map();
  for (const r of snapshotRows) {
    snapshotMap.set(r.entity_type + ':' + r.external_id, r.payload_json);
  }

  // Keys to skip in the raw WFM diff (noisy/structural, not useful to review).
  const SKIP_KEYS = new Set([
    'UUID', 'Dropbox', 'WebURL', 'History', 'Activities', 'Notes',
    'Contacts', 'BillingClient', 'Groups', 'Relationships',
    'Type', // nested object on clients
  ]);

  function rawWfmDiff(wfmPayload, basePayload) {
    const changes = [];
    const allKeys = new Set([
      ...Object.keys(wfmPayload),
      ...(basePayload ? Object.keys(basePayload) : []),
    ]);
    for (const key of allKeys) {
      if (SKIP_KEYS.has(key)) continue;
      const now = wfmPayload[key];
      const was = basePayload ? basePayload[key] : undefined;
      // Skip nested objects (Client, Contact, Owner — shown as context instead).
      if (now && typeof now === 'object') continue;
      if (was && typeof was === 'object') continue;
      const nowStr = now == null ? '' : String(now).trim();
      const wasStr = was == null ? '' : String(was).trim();
      if (nowStr === wasStr) continue;
      changes.push({ key, was: wasStr || null, now: nowStr || null });
    }
    return changes;
  }

  // Parse JSON fields and add display name.
  const parsed = items.map((item) => {
    let diff = {};
    let wfmPayload = {};
    try { diff = JSON.parse(item.fields_diff_json); } catch { /* empty */ }
    try { wfmPayload = JSON.parse(item.wfm_payload_json); } catch { /* empty */ }

    // Derive a display name from the WFM payload.
    const name = wfmPayload.Name || wfmPayload.ID || item.external_id || '?';
    const displayLabel = item.entity_type === 'quote' || item.entity_type === 'job'
      ? ((wfmPayload.ID ? wfmPayload.ID + ' — ' : '') + (wfmPayload.Name || ''))
      : name;

    // Parent context (WFM-side names for related entities).
    const context = {};
    if (wfmPayload.Client?.Name) context.client = wfmPayload.Client.Name;
    if (wfmPayload.Contact?.Name) context.contact = wfmPayload.Contact.Name;
    if (wfmPayload.Owner?.Name) context.owner = wfmPayload.Owner.Name;
    const wfm_uuid = wfmPayload.UUID || item.external_id || null;
    const wfm_created = wfmPayload.Date || null;

    // Raw WFM field diff (against snapshot base).
    let basePayload = null;
    const snapJson = snapshotMap.get(item.entity_type + ':' + item.external_id);
    if (snapJson) { try { basePayload = JSON.parse(snapJson); } catch { /* skip */ } }
    const wfm_changes = rawWfmDiff(wfmPayload, basePayload);

    return {
      id:            item.id,
      entity_type:   item.entity_type,
      external_id:   item.external_id,
      action:        item.action,
      pipeline_row_id: item.pipeline_row_id,
      status:        item.status,
      name:          displayLabel,
      wfm_uuid,
      wfm_created,
      context,
      wfm_changes,
      diff,
      decided_fields: item.decided_fields_json ? JSON.parse(item.decided_fields_json) : null,
    };
  });

  // Summary counts by entity type.
  const summary = {};
  for (const item of parsed) {
    if (!summary[item.entity_type]) summary[item.entity_type] = { pending: 0, approved: 0 };
    summary[item.entity_type][item.status]++;
  }

  return json({ ok: true, run_id: runId, items: parsed, summary });
}

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user || !hasRole(user, 'admin')) return json({ error: 'admin only' }, 403);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const decisions = body?.decisions;
  if (!Array.isArray(decisions) || decisions.length === 0) {
    return json({ ok: false, error: 'No decisions provided' }, 400);
  }

  const ts = nowIso();
  const results = { approved: 0, rejected: 0, skipped: 0, errors: [] };

  // Process in batches.
  const stmts = [];
  for (const d of decisions) {
    if (!d.pending_id || !d.decision) {
      results.errors.push('Missing pending_id or decision');
      continue;
    }

    if (d.decision === 'approve') {
      const fieldsJson = d.fields ? JSON.stringify(d.fields) : null;
      stmts.push(stmt(env.DB,
        `UPDATE wfm_import_pending
            SET status = 'approved', decided_at = ?, decided_fields_json = COALESCE(?, decided_fields_json)
          WHERE id = ? AND status = 'pending'`,
        [ts, fieldsJson, d.pending_id]));
      results.approved++;
    } else if (d.decision === 'reject') {
      stmts.push(stmt(env.DB,
        `UPDATE wfm_import_pending
            SET status = 'rejected', decided_at = ?
          WHERE id = ? AND status = 'pending'`,
        [ts, d.pending_id]));
      results.rejected++;
    } else if (d.decision === 'skip') {
      // Leave as pending — no DB write needed.
      results.skipped++;
    } else {
      results.errors.push(`Unknown decision: ${d.decision}`);
    }
  }

  if (stmts.length > 0) {
    for (let i = 0; i < stmts.length; i += 50) {
      await batch(env.DB, stmts.slice(i, i + 50));
    }
  }

  return json({ ok: true, ...results });
}
