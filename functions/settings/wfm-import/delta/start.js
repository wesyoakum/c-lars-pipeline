// functions/settings/wfm-import/delta/start.js
//
// POST /settings/wfm-import/delta/start
//
// "Refresh changed only" — same fetch shape as a full import, but
// only enqueues plan rows for WFM records that are NEW or whose
// JSON payload differs from what was last stored. Untouched rows
// don't get an UPDATE, so:
//   - updated_at doesn't bump on thousands of rows
//   - audit_events / claudia_writes don't get flooded
//   - welcome-back narration doesn't see a fake "X just changed" surge
//
// Comparison: exact-string equality between JSON.stringify(rec) and
// the wfm_payload column already stored on the matching Pipeline row.
// False-negative-safe: if any field differs, the strings differ, the
// row is included. False-positive (over-include) is harmless — the
// commit path is idempotent.
//
// The work is processed by the same /api/cron/wfm-step ticker used by
// full imports — only the planning differs. Run row mode='delta' so
// the history page can label them; the cron worker treats both modes
// identically.
//
// Refuses to start if either a full or delta run is already in
// progress. Admin-only.

import { hasRole } from '../../../lib/auth.js';
import { all, one, run, stmt, batch } from '../../../lib/db.js';
import { apiGet, recordList, getAccessToken } from '../../../lib/wfm-client.js';

const LIST_PAGE_SIZE = 100;
const SINGLE_SHOT_PAGE_SIZE = 1000;
const MAX_LIST_PAGES = 50;
const PLAN_INSERT_BATCH = 50;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function nowIso() { return new Date().toISOString(); }
function newId()  { return crypto.randomUUID(); }

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

/**
 * Pull stored wfm_payload per WFM external_id from each table the
 * commit path writes to. Returns a per-kind Map<external_id,
 * wfm_payload_string>. Used by the change-detection filter below.
 *
 * Notes on the lead/job ambiguity: the opportunities table holds a
 * lead-shape OR a job-shape payload depending on which kind ran last
 * for that UUID. That's fine for the comparator — exact-string match
 * means a different shape always flags as "changed", which is the
 * conservative direction (include for re-import).
 */
async function loadStoredPayloads(env) {
  const [staffRows, clientRows, oppRows, quoteRows, jobRows] = await Promise.all([
    all(env.DB, "SELECT external_id, wfm_payload FROM users WHERE external_source = 'wfm' AND external_id IS NOT NULL"),
    all(env.DB, "SELECT external_id, wfm_payload FROM accounts WHERE external_source = 'wfm' AND external_id IS NOT NULL"),
    all(env.DB, "SELECT external_id, wfm_payload FROM opportunities WHERE external_source = 'wfm' AND external_id IS NOT NULL"),
    all(env.DB, "SELECT external_id, wfm_payload FROM quotes WHERE external_source = 'wfm' AND external_id IS NOT NULL"),
    all(env.DB, "SELECT external_id, wfm_payload FROM jobs WHERE external_source = 'wfm' AND external_id IS NOT NULL"),
  ]);
  const toMap = (rows) => new Map(rows.map((r) => [r.external_id, r.wfm_payload]));
  return {
    staff:  toMap(staffRows),
    client: toMap(clientRows),
    lead:   toMap(oppRows),  // leads upsert into opportunities
    job:    toMap(jobRows),  // jobs ALSO upsert into opportunities, but we compare against the jobs-table copy
    quote:  toMap(quoteRows),
  };
}

/**
 * Decide whether a freshly-fetched WFM record needs to flow into the
 * plan. Returns true if it's NEW (no stored payload) or CHANGED
 * (stored payload differs from JSON.stringify(rec)).
 *
 * Exact string comparison. WFM responses are deterministic enough
 * across calls that this catches real changes; the only risk is
 * false-positive (over-include) when key order shifts, which is
 * harmless (re-imports an unchanged row).
 */
function isNewOrChanged(stored, recJson) {
  if (stored == null) return true;
  return stored !== recJson;
}

export async function onRequestPost(context) {
  const { env, request, data } = context;
  const user = data?.user;
  if (!user) return json({ ok: false, error: 'sign_in_required' }, 401);
  if (!hasRole(user, 'admin')) return json({ ok: false, error: 'admin_only' }, 403);

  let body = {};
  try { body = await request.json(); } catch { /* empty body OK */ }
  const options = (body && body.options) || {};
  const synthOrphanQuotes = !!options.synth_orphan_quotes;

  // Refuse if any full or delta is already running. Both touch the
  // same Pipeline rows; concurrent runs would race on UPDATEs.
  const existing = await one(env.DB,
    `SELECT id, mode FROM wfm_import_runs
      WHERE mode IN ('full', 'delta') AND status = 'in_progress'
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

  try {
    await getAccessToken(env);

    // Phase 1 — fetch every list (same as full).
    const [staff, clients, leads, quotes, jobs] = await Promise.all([
      apiGet(env, '/staff.api/list').then((r) => r.ok ? recordList(r.body, 'Staff') : []),
      fetchKind(env, '/client.api/list',   'Client'),
      fetchKind(env, '/lead.api/current',  'Lead'),
      fetchKind(env, '/quote.api/current', 'Quote'),
      fetchKind(env, '/job.api/current',   'Job'),
    ]);

    // Phase 1.5 — load stored payloads for the change comparator.
    const stored = await loadStoredPayloads(env);

    // Phase 2 — build plan rows, filtering out unchanged records.
    // Same kind ordering as full so FK cascades resolve naturally.
    const KIND_ORDER = [
      ['staff',   staff,   stored.staff],
      ['client',  clients, stored.client],
      ['lead',    leads,   stored.lead],
      ['quote',   quotes,  stored.quote],
      ['job',     jobs,    stored.job],
    ];

    const counts = {
      staff:   { fetched: staff.length,   changed: 0, new: 0 },
      clients: { fetched: clients.length, changed: 0, new: 0 },
      leads:   { fetched: leads.length,   changed: 0, new: 0 },
      quotes:  { fetched: quotes.length,  changed: 0, new: 0 },
      jobs:    { fetched: jobs.length,    changed: 0, new: 0 },
    };
    const kindToCountKey = { staff: 'staff', client: 'clients', lead: 'leads', quote: 'quotes', job: 'jobs' };

    const planRows = [];
    let sequence = 0;
    for (const [kind, records, storedMap] of KIND_ORDER) {
      const ck = kindToCountKey[kind];
      for (const rec of records) {
        if (!rec.UUID) continue;
        const recJson = JSON.stringify(rec);
        const storedPayload = storedMap.get(rec.UUID);
        if (!isNewOrChanged(storedPayload, recJson)) continue; // unchanged → skip
        if (storedPayload == null) counts[ck].new++;
        else counts[ck].changed++;
        planRows.push({
          id: newId(),
          run_id: runId,
          sequence: sequence++,
          kind,
          external_uuid: rec.UUID,
          record_json: recJson,
        });
      }
    }
    const totalPlanned = planRows.length;

    // Phase 3 — persist run + plan rows. Run row goes first so the
    // cron worker can find it even mid-plan-insert.
    const summary = totalPlanned === 0
      ? 'Delta import — nothing changed; 0 records queued.'
      : `Delta import in progress — ${totalPlanned} changed/new records planned.`;
    await run(env.DB,
      `INSERT INTO wfm_import_runs
         (id, started_at, finished_at, triggered_by, ok, summary,
          counts_json, errors_json, links_json,
          selection_summary_json, selection_size,
          mode, status, options_json, total_planned)
       VALUES (?, ?, NULL, ?, 0, ?, ?, ?, ?, ?, ?, 'delta', ?, ?, ?)`,
      [
        runId,
        startedAt,
        user.email || '',
        summary,
        JSON.stringify({}),
        JSON.stringify([]),
        JSON.stringify([]),
        JSON.stringify([
          { kind: 'staff',   fetched: counts.staff.fetched,   queued: counts.staff.changed + counts.staff.new },
          { kind: 'clients', fetched: counts.clients.fetched, queued: counts.clients.changed + counts.clients.new },
          { kind: 'leads',   fetched: counts.leads.fetched,   queued: counts.leads.changed + counts.leads.new },
          { kind: 'quotes',  fetched: counts.quotes.fetched,  queued: counts.quotes.changed + counts.quotes.new },
          { kind: 'jobs',    fetched: counts.jobs.fetched,    queued: counts.jobs.changed + counts.jobs.new },
        ]),
        totalPlanned,
        // Empty-plan deltas finish immediately so the UI doesn't show a
        // perpetual "in progress" with nothing to do.
        totalPlanned === 0 ? 'completed' : 'in_progress',
        JSON.stringify({ synth_orphan_quotes: synthOrphanQuotes }),
        totalPlanned,
      ]);

    if (totalPlanned === 0) {
      // Nothing to do — close the run cleanly.
      await run(env.DB,
        `UPDATE wfm_import_runs
            SET finished_at = ?, ok = 1
          WHERE id = ?`,
        [nowIso(), runId]);
      return json({
        ok: true,
        run_id: runId,
        total: 0,
        counts,
        message: 'Nothing changed in WFM since the last import. No rows queued.',
      });
    }

    for (let i = 0; i < planRows.length; i += PLAN_INSERT_BATCH) {
      const slice = planRows.slice(i, i + PLAN_INSERT_BATCH);
      const stmts = slice.map((row) => stmt(env.DB,
        `INSERT INTO wfm_import_plans
           (id, run_id, sequence, kind, external_uuid, record_json, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        [row.id, row.run_id, row.sequence, row.kind, row.external_uuid, row.record_json]));
      await batch(env.DB, stmts);
    }

    return json({
      ok: true,
      run_id: runId,
      total: totalPlanned,
      counts,
      message: `Delta import queued: ${totalPlanned} changed/new records out of ${staff.length + clients.length + leads.length + quotes.length + jobs.length} fetched. The cron worker starts within ~1 minute.`,
    });
  } catch (err) {
    try {
      await run(env.DB,
        `UPDATE wfm_import_runs
            SET status = 'failed', finished_at = ?,
                summary = 'failed during delta planning: ' || ?
          WHERE id = ?`,
        [nowIso(), String(err.message || err), runId]);
    } catch (_) { /* run row may not exist yet */ }
    return json({ ok: false, error: 'delta_planning_failed', message: err?.message || String(err) }, 500);
  }
}
