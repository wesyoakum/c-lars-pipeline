// functions/settings/wfm-import/delta/diff-run.js
//
// POST /settings/wfm-import/delta/diff-run
//
// Reads WFM list data from an R2 snapshot, fetches details for changed
// records, diffs against Pipeline, and writes wfm_import_pending rows.
// Called after all 4 /delta/fetch calls have populated the snapshot.
//
// Body: { run_id, snapshot_id }
// Returns: { ok, total, counts, auto_approved, message }
//
// Admin-only.

import { hasRole } from '../../../lib/auth.js';
import { all, one, run, stmt, batch } from '../../../lib/db.js';
import { computeDiff, displayName } from './diff.js';
import {
  readSnapshotKind, writeManifest,
  completeSnapshotRow, failSnapshotRow,
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

// ---------- Load stored data ----------

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
  for (const r of rows) map.set(r.entity_type + ':' + r.external_id, r.payload_json);
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

const KIND_TO_ENTITY = { client: 'account', lead: 'opportunity', quote: 'quote', job: 'job' };

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user || !hasRole(user, 'admin')) return json({ error: 'admin only' }, 403);

  let body = {};
  try { body = await request.json(); } catch { /* empty */ }

  const runId = body?.run_id;
  const snapshotId = body?.snapshot_id;
  if (!runId || !snapshotId) {
    return json({ ok: false, error: 'run_id and snapshot_id required' }, 400);
  }

  const startedAt = nowIso();
  const t0 = Date.now();

  try {
    // Load snapshot data from R2 (list + details already fetched by /delta/fetch).
    const [clientData, leadData, quoteData, jobData] = await Promise.all([
      readSnapshotKind(env.DOCS, snapshotId, 'client'),
      readSnapshotKind(env.DOCS, snapshotId, 'lead'),
      readSnapshotKind(env.DOCS, snapshotId, 'quote'),
      readSnapshotKind(env.DOCS, snapshotId, 'job'),
    ]);

    for (const [kind, d] of Object.entries({ client: clientData, lead: leadData, quote: quoteData, job: jobData })) {
      if (!d) return json({ ok: false, error: 'Snapshot missing ' + kind + '.json' }, 500);
    }

    const clients = clientData.list;
    const leads = leadData.list;
    const quotes = quoteData.list;
    const jobs = jobData.list;

    // Build detail lookup from snapshot (populated by /delta/fetch details phase).
    const detailLookup = {
      client: clientData.details || {},
      lead:   leadData.details || {},
      quote:  quoteData.details || {},
      job:    jobData.details || {},
    };

    // Load Pipeline state.
    const [stored, pipelineRows, snapshots, dismissed] = await Promise.all([
      loadStoredPayloads(env),
      loadPipelineRows(env),
      loadSnapshots(env),
      loadDismissed(env),
    ]);

    // Phase 2 — coarse filter with field-level pre-check.
    const KIND_ORDER = [
      ['client',  clients, stored.client],
      ['lead',    leads,   stored.lead],
      ['quote',   quotes,  stored.quote],
      ['job',     jobs,    stored.job],
    ];

    const counts = {
      accounts:      { fetched: clients.length, changed: 0, new: 0, auto_approved: 0, dismissed_skipped: 0 },
      opportunities: { fetched: leads.length,   changed: 0, new: 0, auto_approved: 0, dismissed_skipped: 0 },
      quotes:        { fetched: quotes.length,  changed: 0, new: 0, auto_approved: 0, dismissed_skipped: 0 },
      jobs:          { fetched: jobs.length,     changed: 0, new: 0, auto_approved: 0, dismissed_skipped: 0 },
    };
    const kindToCountKey = { client: 'accounts', lead: 'opportunities', quote: 'quotes', job: 'jobs' };

    const snapshotObjs = new Map();
    for (const [key, jsonStr] of snapshots) {
      try { snapshotObjs.set(key, JSON.parse(jsonStr)); } catch { /* skip */ }
    }

    // Single pass: use detail records from snapshot for accurate diffs.
    const pendingRows = [];
    const supersedeBatch = [];

    for (const [kind, records, storedMap] of KIND_ORDER) {
      const ck = kindToCountKey[kind];
      const entityType = KIND_TO_ENTITY[kind];
      const kindDetails = detailLookup[kind];

      for (const rec of records) {
        if (!rec.UUID) continue;

        const isNew = storedMap.get(rec.UUID) == null;
        const pipelineRow = isNew ? null : ((pipelineRows[kind] || new Map()).get(rec.UUID) || null);

        // Use detail record from snapshot (full fields); fall back to list record.
        const detail = kindDetails[rec.UUID] || rec;
        const detailJson = JSON.stringify(detail);

        // Load merge-base snapshot.
        const snapKey = entityType + ':' + rec.UUID;
        let snapshotPayload = snapshotObjs.get(snapKey) || null;
        if (!snapshotPayload && pipelineRow) {
          const storedWfm = storedMap.get(rec.UUID);
          if (storedWfm) {
            try { snapshotPayload = JSON.parse(storedWfm); } catch { /* skip */ }
          }
        }

        // Diff using the full detail record.
        const { diff, hasConflict, hasAutoApply, isInsert, allUnchanged } = computeDiff(
          entityType, detail, pipelineRow, snapshotPayload
        );

        if (allUnchanged && !isInsert) continue;

        if (isNew) counts[ck].new++;
        else counts[ck].changed++;

        // Dismiss check.
        const dismissKey = entityType + ':' + rec.UUID;
        const dismissedPayload = dismissed.get(dismissKey);
        if (dismissedPayload && dismissedPayload === detailJson) {
          counts[ck].dismissed_skipped++;
          continue;
        }

        const allCase3 = !isInsert && !hasConflict &&
          Object.values(diff).every(d => d.case === 1 || d.case === 3 || d.case === 4 || d.case === 7);
        const autoApproved = allCase3 && hasAutoApply;
        if (autoApproved) counts[ck].auto_approved++;

        supersedeBatch.push(stmt(env.DB,
          `UPDATE wfm_import_pending SET status = 'superseded', decided_at = ?
            WHERE entity_type = ? AND external_id = ? AND status = 'pending'`,
          [startedAt, entityType, rec.UUID]));

        pendingRows.push({
          id:                    newId(),
          run_id:                runId,
          entity_type:           entityType,
          external_id:           rec.UUID,
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
    }

    const totalPending = pendingRows.length;

    // Finalize snapshot (details already written by /delta/fetch).
    const snapshotCounts = {
      client:  { list: clients.length, details: Object.keys(detailLookup.client).length },
      lead:    { list: leads.length,   details: Object.keys(detailLookup.lead).length },
      quote:   { list: quotes.length,  details: Object.keys(detailLookup.quote).length },
      job:     { list: jobs.length,    details: Object.keys(detailLookup.job).length },
    };
    await writeManifest(env.DOCS, snapshotId, {
      id: snapshotId, created_at: startedAt, created_by: user?.email,
      counts: snapshotCounts, diff_run_id: runId,
    });
    await completeSnapshotRow(env.DB, {
      id: snapshotId, counts: snapshotCounts, durationMs: Date.now() - t0, diffRunId: runId,
    });

    // Persist pending rows.
    const kindSummary = Object.entries(counts)
      .filter(([_, v]) => v.changed + v.new > 0)
      .map(([k, v]) => `${k}: ${v.changed} changed + ${v.new} new`)
      .join(' · ');
    const summary = totalPending === 0
      ? 'No changes found.'
      : `${totalPending} changes for review — ${kindSummary}`;

    if (totalPending === 0) {
      await run(env.DB,
        `UPDATE wfm_import_runs
            SET status = 'completed', finished_at = ?, ok = 1,
                summary = ?, counts_json = ?, total_planned = 0
          WHERE id = ?`,
        [nowIso(), summary, JSON.stringify(counts), runId]);
      return json({ ok: true, run_id: runId, total: 0, counts, message: summary });
    }

    if (supersedeBatch.length > 0) {
      for (let i = 0; i < supersedeBatch.length; i += PENDING_INSERT_BATCH) {
        await batch(env.DB, supersedeBatch.slice(i, i + PENDING_INSERT_BATCH));
      }
    }

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

    await run(env.DB,
      `UPDATE wfm_import_runs
          SET summary = ?, counts_json = ?,
              selection_summary_json = ?, selection_size = ?, total_planned = ?
        WHERE id = ?`,
      [summary, JSON.stringify(counts),
       JSON.stringify(Object.entries(counts).map(([k, v]) => ({
         kind: k, fetched: v.fetched, queued: v.changed + v.new, auto_approved: v.auto_approved,
       }))),
       totalPending, totalPending, runId]);

    return json({
      ok: true, run_id: runId, snapshot_id: snapshotId,
      total: totalPending, counts,
      auto_approved: pendingRows.filter(r => r.status === 'approved').length,
      message: summary,
    });
  } catch (err) {
    try {
      await run(env.DB,
        `UPDATE wfm_import_runs SET status = 'failed', finished_at = ?, summary = 'diff failed: ' || ? WHERE id = ?`,
        [nowIso(), String(err.message || err), runId]);
    } catch (_) { /* best-effort */ }
    try { await failSnapshotRow(env.DB, { id: snapshotId, error: err.message }); }
    catch (_) { /* best-effort */ }
    return json({ ok: false, error: err?.message || String(err) }, 500);
  }
}
