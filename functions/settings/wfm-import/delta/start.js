// functions/settings/wfm-import/delta/start.js
//
// POST /settings/wfm-import/delta/start
//
// "Check for changes" — fetches all WFM lists + details, compares
// against stored payloads, and populates wfm_import_pending with
// field-by-field diffs for user review. Nothing touches Pipeline
// until the user approves and clicks Apply.
//
// The WFM API takes 30-90s for ~1,100 records, which exceeds the
// Pages Functions HTTP timeout. The Worker execution continues past
// the timeout — D1 writes complete even if the browser gets no
// response. The run row is created early so the browser can detect
// and poll it on timeout via GET /delta/status.
//
// Admin-only.

import { hasRole } from '../../../lib/auth.js';
import { all, one, run, stmt, batch } from '../../../lib/db.js';
import { apiGet, recordList, getAccessToken } from '../../../lib/wfm-client.js';
import { computeDiff, displayName } from './diff.js';
import {
  createSnapshotRow, completeSnapshotRow, failSnapshotRow,
  latestCompleteSnapshot,
  writeSnapshotKind, writeManifest,
} from '../../../lib/wfm-snapshot.js';

const LIST_PAGE_SIZE = 100;
const SINGLE_SHOT_PAGE_SIZE = 1000;
const MAX_LIST_PAGES = 50;
const PENDING_INSERT_BATCH = 50;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function nowIso() { return new Date().toISOString(); }
function newId()  { return crypto.randomUUID(); }

// ---------- WFM fetch infrastructure ----------

async function readTotalRecords(env, basePath) {
  const sep = basePath.includes('?') ? '&' : '?';
  const r = await apiGet(env, basePath + sep + 'page=1&pageSize=1');
  if (!r.ok) return null;
  const totalStr = r.body?.Response?.TotalRecords;
  if (!totalStr) return null;
  const n = parseInt(totalStr, 10);
  return Number.isNaN(n) ? null : n;
}

async function fetchAllPaginated(env, basePath, primaryKey) {
  const out = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const sep = basePath.includes('?') ? '&' : '?';
    const r = await apiGet(env, basePath + sep + 'page=' + page + '&pageSize=' + LIST_PAGE_SIZE);
    if (!r.ok) break;
    const arr = recordList(r.body, primaryKey);
    if (arr.length === 0) break;
    for (const rec of arr) {
      const id = rec.UUID || rec.ID;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      out.push(rec);
    }
    if (arr.length < LIST_PAGE_SIZE) break;
  }
  return out;
}

async function fetchSingleShot(env, basePath, primaryKey) {
  const sep = basePath.includes('?') ? '&' : '?';
  const r = await apiGet(env, basePath + sep + 'pageSize=' + SINGLE_SHOT_PAGE_SIZE);
  if (!r.ok) return [];
  return recordList(r.body, primaryKey);
}

async function fetchKind(env, basePath, primaryKey) {
  const total = await readTotalRecords(env, basePath);
  if (total === null) return await fetchSingleShot(env, basePath, primaryKey);
  return await fetchAllPaginated(env, basePath, primaryKey);
}

// ---------- Detail fetchers ----------

async function fetchDetail(env, kind, uuid, cache) {
  const key = kind + ':' + uuid;
  if (cache.has(key)) return cache.get(key);
  const pathMap = {
    client: '/client.api/get/',
    lead:   '/lead.api/get/',
    quote:  '/quote.api/get/',
    job:    '/job.api/get/',
  };
  const singularMap = { client: 'Client', lead: 'Lead', quote: 'Quote', job: 'Job' };
  const path = pathMap[kind];
  if (!path) { cache.set(key, null); return null; }
  const r = await apiGet(env, path + encodeURIComponent(uuid));
  const result = r.ok ? (recordList(r.body, singularMap[kind])[0] || null) : null;
  cache.set(key, result);
  return result;
}

// ---------- Load stored data for comparison ----------

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

// Entity type mapping: WFM kind → Pipeline entity_type for wfm_import_pending.
const KIND_TO_ENTITY = { client: 'account', lead: 'opportunity', quote: 'quote', job: 'job' };

export async function onRequestPost(context) {
  const { env, request, data } = context;
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
  const t0 = Date.now();

  // Create run row EARLY so the browser can find it if the HTTP response
  // times out (the Worker execution continues past the 30s timeout).
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

  try {
    await getAccessToken(env);

    const prevSnapshot = await latestCompleteSnapshot(env.DB);
    await createSnapshotRow(env.DB, {
      id: snapshotId,
      createdBy: user.email,
      parentId: prevSnapshot?.id || null,
    });

    // Phase 1 — fetch every WFM list.
    const dateRange = 'from=2020-01-01&to=2027-12-31';
    const [clients, leads, quotes, jobs] = await Promise.all([
      fetchKind(env, '/client.api/list',              'Client'),
      fetchKind(env, `/lead.api/list?${dateRange}`,   'Lead'),
      fetchKind(env, `/quote.api/list?${dateRange}`,  'Quote'),
      fetchKind(env, `/job.api/list?${dateRange}`,    'Job'),
    ]);

    // Phase 1.5 — load stored payloads, Pipeline rows, snapshots, dismissed.
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

    const changedRecords = [];
    for (const [kind, records, storedMap] of KIND_ORDER) {
      const ck = kindToCountKey[kind];
      const entityType = KIND_TO_ENTITY[kind];
      for (const rec of records) {
        if (!rec.UUID) continue;

        const isNew = storedMap.get(rec.UUID) == null;
        if (isNew) {
          counts[ck].new++;
          changedRecords.push({ kind, uuid: rec.UUID, listRec: rec, pipelineRow: null, snapshotPayload: null });
          continue;
        }

        const pipelineRow = (pipelineRows[kind] || new Map()).get(rec.UUID) || null;
        const snapKey = entityType + ':' + rec.UUID;
        let snapshotPayload = snapshotObjs.get(snapKey) || null;
        if (!snapshotPayload && pipelineRow) {
          const storedWfm = storedMap.get(rec.UUID);
          if (storedWfm) {
            try { snapshotPayload = JSON.parse(storedWfm); } catch { /* skip */ }
          }
        }

        const prelim = computeDiff(entityType, rec, pipelineRow, snapshotPayload);
        if (prelim.allUnchanged) continue;

        counts[ck].changed++;
        changedRecords.push({ kind, uuid: rec.UUID, listRec: rec, pipelineRow, snapshotPayload });
      }
    }

    // Phase 3 — fetch detail + compute full diffs for changed records only.
    const fetchCache = new Map();
    const pendingRows = [];
    const supersedeBatch = [];

    for (const { kind, uuid, listRec, pipelineRow, snapshotPayload } of changedRecords) {
      const entityType = KIND_TO_ENTITY[kind];
      const ck = kindToCountKey[kind];

      let detail = listRec;
      if (kind !== 'staff') {
        const fetched = await fetchDetail(env, kind, uuid, fetchCache);
        if (fetched) detail = fetched;
      }
      const detailJson = JSON.stringify(detail);

      const dismissKey = entityType + ':' + uuid;
      const dismissedPayload = dismissed.get(dismissKey);
      if (dismissedPayload && dismissedPayload === detailJson) {
        counts[ck].dismissed_skipped++;
        continue;
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

    // Phase 3.5 — write R2 snapshot (non-blocking via waitUntil).
    const snapshotData = {
      client:  { list: clients,  details: {} },
      lead:    { list: leads,    details: {} },
      quote:   { list: quotes,   details: {} },
      job:     { list: jobs,     details: {} },
    };
    for (const [key, val] of fetchCache) {
      if (!val) continue;
      const [kind, uuid] = key.split(':');
      if (snapshotData[kind]) snapshotData[kind].details[uuid] = val;
    }
    const snapshotCounts = {
      client:  { list: clients.length, details: Object.keys(snapshotData.client.details).length },
      lead:    { list: leads.length,   details: Object.keys(snapshotData.lead.details).length },
      quote:   { list: quotes.length,  details: Object.keys(snapshotData.quote.details).length },
      job:     { list: jobs.length,    details: Object.keys(snapshotData.job.details).length },
    };
    context.waitUntil((async () => {
      try {
        for (const kind of ['client', 'lead', 'quote', 'job']) {
          await writeSnapshotKind(env.DOCS, snapshotId, kind, snapshotData[kind]);
        }
        await writeManifest(env.DOCS, snapshotId, {
          id: snapshotId, created_at: startedAt, created_by: user.email,
          parent_id: prevSnapshot?.id || null, counts: snapshotCounts, diff_run_id: runId,
        });
        await completeSnapshotRow(env.DB, {
          id: snapshotId, counts: snapshotCounts, durationMs: Date.now() - t0, diffRunId: runId,
        });
      } catch (snapErr) {
        try { await failSnapshotRow(env.DB, { id: snapshotId, error: snapErr.message }); }
        catch (_) { /* best-effort */ }
      }
    })());

    // Phase 4 — update run row + persist pending rows.
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
      return json({
        ok: true, run_id: runId, snapshot_id: snapshotId,
        total: 0, counts, message: summary,
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

    // Finalize run row with counts.
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
        `UPDATE wfm_import_runs
            SET status = 'failed', finished_at = ?,
                summary = 'failed during delta review: ' || ?
          WHERE id = ?`,
        [nowIso(), String(err.message || err), runId]);
    } catch (_) { /* best-effort */ }
    try { await failSnapshotRow(env.DB, { id: snapshotId, error: err.message }); }
    catch (_) { /* best-effort */ }
    return json({ ok: false, error: 'delta_review_failed', message: err?.message || String(err) }, 500);
  }
}
