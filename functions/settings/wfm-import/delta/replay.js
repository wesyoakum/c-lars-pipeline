// functions/settings/wfm-import/delta/replay.js
//
// POST /settings/wfm-import/delta/replay
//
// Re-runs the Pipeline diff logic from a previously captured R2 snapshot,
// without hitting the WFM API. Use case: fix a mapping bug in diff.js or
// commit.js, then replay without re-fetching from WFM.
//
// Produces the same output as delta/start — a wfm_import_runs row with
// mode='delta-review' and wfm_import_pending rows for user review.
//
// Admin-only.

import { hasRole } from '../../../lib/auth.js';
import { all, one, run, stmt, batch } from '../../../lib/db.js';
import { computeDiff, displayName } from './diff.js';
import {
  getSnapshot, readSnapshotKind,
} from '../../../lib/wfm-snapshot.js';

const PENDING_INSERT_BATCH = 50;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function nowIso() { return new Date().toISOString(); }
function newId()  { return crypto.randomUUID(); }

// Entity type mapping: WFM kind → Pipeline entity_type for wfm_import_pending.
const KIND_TO_ENTITY = { client: 'account', lead: 'opportunity', quote: 'quote', job: 'job' };

// ---------- Load stored data for comparison (same as start.js) ----------

async function loadStoredPayloads(env) {
  const [clientRows, oppRows, quoteRows, jobRows] = await Promise.all([
    all(env.DB, "SELECT external_id, wfm_payload FROM accounts WHERE external_source = 'wfm' AND external_id IS NOT NULL"),
    all(env.DB, "SELECT external_id, wfm_payload FROM opportunities WHERE external_source LIKE 'wfm%' AND external_id IS NOT NULL"),
    all(env.DB, "SELECT external_id, wfm_payload FROM quotes WHERE external_source = 'wfm' AND external_id IS NOT NULL"),
    all(env.DB, "SELECT external_id, wfm_payload FROM jobs WHERE external_source = 'wfm' AND external_id IS NOT NULL"),
  ]);
  const toMap = (rows) => new Map(rows.map((r) => [r.external_id, r.wfm_payload]));
  return { client: toMap(clientRows), lead: toMap(oppRows), quote: toMap(quoteRows), job: toMap(jobRows) };
}

async function loadPipelineRows(env) {
  const [accts, opps, quotes, jobs] = await Promise.all([
    all(env.DB, "SELECT id, external_id, name, email, phone, fax, website, address_billing, address_physical, account_manager_name, referral_source, export_code, is_archived, is_prospect FROM accounts WHERE external_source = 'wfm' AND external_id IS NOT NULL"),
    all(env.DB, "SELECT id, external_id, title, description, stage, estimated_value_usd, actual_close_date, wfm_category FROM opportunities WHERE external_source LIKE 'wfm%' AND external_id IS NOT NULL"),
    all(env.DB, "SELECT id, external_id, title, description, status, subtotal_price, tax_amount, total_price, valid_until, notes_customer, wfm_state FROM quotes WHERE external_source = 'wfm' AND external_id IS NOT NULL"),
    all(env.DB, "SELECT id, external_id, title, job_type, status, customer_po_number, wfm_number FROM jobs WHERE external_source = 'wfm' AND external_id IS NOT NULL"),
  ]);
  const toMap = (rows) => new Map(rows.map((r) => [r.external_id, r]));
  return { client: toMap(accts), lead: toMap(opps), quote: toMap(quotes), job: toMap(jobs) };
}

async function loadSnapshots(env) {
  const rows = await all(env.DB,
    'SELECT entity_type, external_id, payload_json FROM wfm_import_snapshots');
  const map = new Map();
  for (const r of rows) {
    map.set(r.entity_type + ':' + r.external_id, r.payload_json);
  }
  return map;
}

async function loadDismissed(env) {
  const rows = await all(env.DB,
    "SELECT entity_type, external_id, wfm_payload_json FROM wfm_import_pending WHERE status = 'rejected' ORDER BY created_at DESC");
  const map = new Map();
  for (const r of rows) {
    const key = r.entity_type + ':' + r.external_id;
    if (!map.has(key)) map.set(key, r.wfm_payload_json);
  }
  return map;
}

function isNewOrChanged(stored, recJson) {
  if (stored == null) return true;
  return stored !== recJson;
}

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user) return json({ ok: false, error: 'sign_in_required' }, 401);
  if (!hasRole(user, 'admin')) return json({ ok: false, error: 'admin_only' }, 403);

  let body = {};
  try { body = await request.json(); } catch { /* empty body OK */ }

  const snapshotId = body?.snapshot_id;
  if (!snapshotId) {
    return json({ ok: false, error: 'snapshot_id_required', message: 'Provide a snapshot_id to replay.' }, 400);
  }

  // Validate snapshot exists and is complete.
  const snap = await getSnapshot(env.DB, snapshotId);
  if (!snap) {
    return json({ ok: false, error: 'snapshot_not_found', message: 'Snapshot not found.' }, 404);
  }
  if (snap.status !== 'complete') {
    return json({ ok: false, error: 'snapshot_incomplete', message: `Snapshot status is '${snap.status}', not 'complete'.` }, 409);
  }

  // Conflict check — refuse if any import is already running.
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

  // Staleness: how old is this snapshot?
  const snapshotAge = snap.created_at
    ? Math.round((Date.now() - new Date(snap.created_at).getTime()) / 3600000)
    : null;

  try {
    // Load snapshot data from R2.
    const [clientData, leadData, quoteData, jobData] = await Promise.all([
      readSnapshotKind(env.DOCS, snapshotId, 'client'),
      readSnapshotKind(env.DOCS, snapshotId, 'lead'),
      readSnapshotKind(env.DOCS, snapshotId, 'quote'),
      readSnapshotKind(env.DOCS, snapshotId, 'job'),
    ]);

    const snapshotKinds = { client: clientData, lead: leadData, quote: quoteData, job: jobData };
    for (const [kind, d] of Object.entries(snapshotKinds)) {
      if (!d) {
        return json({ ok: false, error: 'snapshot_missing_kind', message: `Snapshot is missing ${kind}.json in R2.` }, 500);
      }
    }

    // Load current Pipeline state for comparison.
    const [stored, pipelineRows, mergeBaseSnapshots, dismissed] = await Promise.all([
      loadStoredPayloads(env),
      loadPipelineRows(env),
      loadSnapshots(env),
      loadDismissed(env),
    ]);

    // Coarse filter: find changed/new records using snapshot list data.
    const KIND_ORDER = [
      ['client',  snapshotKinds.client.list,  stored.client],
      ['lead',    snapshotKinds.lead.list,    stored.lead],
      ['quote',   snapshotKinds.quote.list,   stored.quote],
      ['job',     snapshotKinds.job.list,     stored.job],
    ];

    const counts = {
      accounts:      { fetched: snapshotKinds.client.list.length, changed: 0, new: 0, auto_approved: 0, dismissed_skipped: 0 },
      opportunities: { fetched: snapshotKinds.lead.list.length,   changed: 0, new: 0, auto_approved: 0, dismissed_skipped: 0 },
      quotes:        { fetched: snapshotKinds.quote.list.length,  changed: 0, new: 0, auto_approved: 0, dismissed_skipped: 0 },
      jobs:          { fetched: snapshotKinds.job.list.length,     changed: 0, new: 0, auto_approved: 0, dismissed_skipped: 0 },
    };
    const kindToCountKey = { client: 'accounts', lead: 'opportunities', quote: 'quotes', job: 'jobs' };

    const changedRecords = [];
    for (const [kind, records, storedMap] of KIND_ORDER) {
      const ck = kindToCountKey[kind];
      for (const rec of records) {
        if (!rec.UUID) continue;
        const recJson = JSON.stringify(rec);
        const storedPayload = storedMap.get(rec.UUID);
        if (!isNewOrChanged(storedPayload, recJson)) continue;
        if (storedPayload == null) counts[ck].new++;
        else counts[ck].changed++;
        changedRecords.push({ kind, uuid: rec.UUID, listRec: rec });
      }
    }

    // Compute diffs using snapshot detail data (no WFM API calls).
    const pendingRows = [];
    const supersedeBatch = [];

    for (const { kind, uuid, listRec } of changedRecords) {
      const entityType = KIND_TO_ENTITY[kind];
      const ck = kindToCountKey[kind];

      // Use detail from snapshot if available, else fall back to list record.
      const detail = snapshotKinds[kind].details[uuid] || listRec;
      const detailJson = JSON.stringify(detail);

      // Dismiss check.
      const dismissKey = entityType + ':' + uuid;
      const dismissedPayload = dismissed.get(dismissKey);
      if (dismissedPayload && dismissedPayload === detailJson) {
        counts[ck].dismissed_skipped++;
        continue;
      }

      // Load Pipeline row + merge-base snapshot for diff.
      const pipelineRow = (pipelineRows[kind] || new Map()).get(uuid) || null;
      const snapshotKey = entityType + ':' + uuid;
      let snapshotPayload = null;
      const snapshotJson = mergeBaseSnapshots.get(snapshotKey);
      if (snapshotJson) {
        try { snapshotPayload = JSON.parse(snapshotJson); } catch { /* no snapshot */ }
      }
      if (!snapshotPayload && pipelineRow) {
        const storedWfm = (stored[kind] || new Map()).get(uuid);
        if (storedWfm) {
          try { snapshotPayload = JSON.parse(storedWfm); } catch { /* skip */ }
        }
      }

      const { diff, hasConflict, hasAutoApply, isInsert, allUnchanged } = computeDiff(
        entityType, detail, pipelineRow, snapshotPayload
      );

      if (allUnchanged && !isInsert) continue;

      const allCase3 = !isInsert && !hasConflict &&
        Object.values(diff).every(d => d.case === 1 || d.case === 3 || d.case === 4 || d.case === 7);
      const autoApproved = allCase3 && hasAutoApply;
      if (autoApproved) counts[ck].auto_approved++;

      supersedeBatch.push(stmt(env.DB,
        `UPDATE wfm_import_pending SET status = 'superseded', decided_at = ?
          WHERE entity_type = ? AND external_id = ? AND status = 'pending'`,
        [startedAt, entityType, uuid]));

      pendingRows.push({
        id:                    newId(),
        run_id:                runId,
        entity_type:           entityType,
        external_id:           uuid,
        action:                isInsert ? 'insert' : 'update',
        pipeline_row_id:       pipelineRow?.id || null,
        wfm_payload_json:      detailJson,
        pipeline_snapshot_json: pipelineRow ? JSON.stringify(pipelineRow) : null,
        fields_diff_json:      JSON.stringify(diff),
        status:                autoApproved ? 'approved' : 'pending',
        decided_fields_json:   autoApproved ? JSON.stringify(
          Object.fromEntries(Object.keys(diff).map(k => [k, 'wfm']))
        ) : null,
        created_at:            startedAt,
        _name:                 displayName(entityType, detail),
      });
    }

    const totalPending = pendingRows.length;

    const kindSummary = Object.entries(counts)
      .filter(([_, v]) => v.changed + v.new > 0)
      .map(([k, v]) => `${k}: ${v.changed} changed + ${v.new} new`)
      .join(' · ');
    const staleness = snapshotAge != null ? ` (snapshot is ${snapshotAge}h old)` : '';
    const summary = totalPending === 0
      ? `No changes found (replayed from snapshot${staleness}).`
      : `${totalPending} changes for review — ${kindSummary}${staleness}`;

    await run(env.DB,
      `INSERT INTO wfm_import_runs
         (id, started_at, finished_at, triggered_by, ok, summary,
          counts_json, errors_json, links_json,
          selection_summary_json, selection_size,
          mode, status, options_json, total_planned)
       VALUES (?, ?, NULL, ?, 0, ?, ?, ?, ?, ?, ?, 'delta-review', ?, ?, ?)`,
      [
        runId, startedAt, user.email || '', summary,
        JSON.stringify(counts),
        JSON.stringify([]),
        JSON.stringify([]),
        JSON.stringify(Object.entries(counts).map(([k, v]) => ({
          kind: k, fetched: v.fetched,
          queued: v.changed + v.new,
          auto_approved: v.auto_approved,
        }))),
        totalPending,
        totalPending === 0 ? 'completed' : 'in_progress',
        JSON.stringify({ replayed_snapshot_id: snapshotId }),
        totalPending,
      ]);

    if (totalPending === 0) {
      await run(env.DB,
        'UPDATE wfm_import_runs SET finished_at = ?, ok = 1 WHERE id = ?',
        [nowIso(), runId]);
      return json({
        ok: true,
        run_id: runId,
        snapshot_id: snapshotId,
        snapshot_age_hours: snapshotAge,
        total: 0,
        counts,
        message: summary,
      });
    }

    // Supersede old pending rows.
    if (supersedeBatch.length > 0) {
      for (let i = 0; i < supersedeBatch.length; i += PENDING_INSERT_BATCH) {
        await batch(env.DB, supersedeBatch.slice(i, i + PENDING_INSERT_BATCH));
      }
    }

    // Insert pending rows.
    for (let i = 0; i < pendingRows.length; i += PENDING_INSERT_BATCH) {
      const slice = pendingRows.slice(i, i + PENDING_INSERT_BATCH);
      const stmts = slice.map((row) => stmt(env.DB,
        `INSERT INTO wfm_import_pending
           (id, run_id, entity_type, external_id, action,
            pipeline_row_id, wfm_payload_json, pipeline_snapshot_json,
            fields_diff_json, status, decided_fields_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.id, row.run_id, row.entity_type, row.external_id, row.action,
         row.pipeline_row_id, row.wfm_payload_json, row.pipeline_snapshot_json,
         row.fields_diff_json, row.status, row.decided_fields_json, row.created_at]));
      await batch(env.DB, stmts);
    }

    return json({
      ok: true,
      run_id: runId,
      snapshot_id: snapshotId,
      snapshot_age_hours: snapshotAge,
      total: totalPending,
      counts,
      auto_approved: pendingRows.filter(r => r.status === 'approved').length,
      message: summary,
    });
  } catch (err) {
    try {
      await run(env.DB,
        `UPDATE wfm_import_runs
            SET status = 'failed', finished_at = ?,
                summary = 'failed during snapshot replay: ' || ?
          WHERE id = ?`,
        [nowIso(), String(err.message || err), runId]);
    } catch (_) { /* run row may not exist yet */ }
    return json({ ok: false, error: 'replay_failed', message: err?.message || String(err) }, 500);
  }
}
