// functions/settings/wfm-import/full/start.js
//
// POST /settings/wfm-import/full/start
//
// Kicks off a background full WFM import. Walks every WFM list
// endpoint in parallel, snapshots the records into the
// wfm_import_plans work queue, creates a wfm_import_runs row in
// mode='full' / status='in_progress', and returns immediately.
//
// The actual record-by-record import happens in /api/cron/wfm-step
// ticks (cron worker fires every minute). The browser only kicks off
// and polls /full/status — closing the tab does NOT pause the import.
//
// Body: { options?: { synth_orphan_quotes: boolean } }
//   options.synth_orphan_quotes is persisted on the run row so the
//   cron step uses the same setting on every chunk.
//
// Refuses to start if there's already an in-progress full-import run.
// The user must cancel that run first (or wait for it to finish).
//
// Admin only.

import { hasRole } from '../../../lib/auth.js';
import { all, one, run, stmt, batch } from '../../../lib/db.js';
import { apiGet, recordList } from '../../../lib/wfm-client.js';

const LIST_PAGE_SIZE = 100;
const SINGLE_SHOT_PAGE_SIZE = 1000;
const MAX_LIST_PAGES = 50;
const PLAN_INSERT_BATCH = 50;   // D1 happily takes ~100/batch; 50 keeps room.

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

export async function onRequestPost(context) {
  const { env, request, data } = context;
  const user = data?.user;
  if (!user) return json({ ok: false, error: 'sign_in_required' }, 401);
  if (!hasRole(user, 'admin')) return json({ ok: false, error: 'admin_only' }, 403);

  let body = {};
  try { body = await request.json(); } catch { /* empty body OK */ }
  const options = (body && body.options) || {};
  const synthOrphanQuotes = !!options.synth_orphan_quotes;

  // Refuse if there's already an in-progress full-import run.
  const existing = await one(env.DB,
    `SELECT id FROM wfm_import_runs
      WHERE mode = 'full' AND status = 'in_progress'
      ORDER BY started_at DESC LIMIT 1`);
  if (existing) {
    return json({
      ok: false,
      error: 'already_in_progress',
      run_id: existing.id,
      message: 'A full import is already running. Cancel it first or wait for it to finish.',
    }, 409);
  }

  const startedAt = nowIso();
  const runId = newId();

  try {
    // -------- Phase 1: walk every WFM list endpoint --------
    // Five list calls in parallel. /staff.api/list is small,
    // /client.api/list paginates, the three /current endpoints are
    // single-shot. Total wall-clock = max(slowest call) ≈ 5–10s.
    const [staff, clients, leads, quotes, jobs] = await Promise.all([
      apiGet(env, '/staff.api/list').then((r) => r.ok ? recordList(r.body, 'Staff') : []),
      fetchKind(env, '/client.api/list',   'Client'),
      fetchKind(env, '/lead.api/current',  'Lead'),
      fetchKind(env, '/quote.api/current', 'Quote'),
      fetchKind(env, '/job.api/current',   'Job'),
    ]);

    // -------- Phase 2: build plan rows --------
    // Order: staff (no FKs) → clients → leads → quotes → jobs.
    // The cron step processes plans in sequence order so cascades
    // resolve naturally — earlier kinds are imported first.
    const KIND_ORDER = [
      ['staff',   staff],
      ['client',  clients],
      ['lead',    leads],
      ['quote',   quotes],
      ['job',     jobs],
    ];

    const planRows = [];
    let sequence = 0;
    for (const [kind, records] of KIND_ORDER) {
      for (const rec of records) {
        if (!rec.UUID) continue;   // can't track without a stable ID
        planRows.push({
          id: newId(),
          run_id: runId,
          sequence: sequence++,
          kind,
          external_uuid: rec.UUID,
          record_json: JSON.stringify(rec),
        });
      }
    }
    const totalPlanned = planRows.length;

    // -------- Phase 3: persist run row + plan rows --------
    // Insert the run row first so the cron step can find it even if
    // plan-row inserts are in flight.
    await run(env.DB,
      `INSERT INTO wfm_import_runs
         (id, started_at, finished_at, triggered_by, ok, summary,
          counts_json, errors_json, links_json,
          selection_summary_json, selection_size,
          mode, status, options_json, total_planned)
       VALUES (?, ?, NULL, ?, 0, ?, ?, ?, ?, ?, ?, 'full', 'in_progress', ?, ?)`,
      [
        runId,
        startedAt,
        user.email || '',
        'Full import in progress — ' + totalPlanned + ' records planned.',
        JSON.stringify({}),  // counts (empty initially)
        JSON.stringify([]),  // errors (empty initially)
        JSON.stringify([]),  // links (empty initially)
        JSON.stringify([    // light selection summary just so history page can render
          { kind: 'staff',   count: staff.length },
          { kind: 'clients', count: clients.length },
          { kind: 'leads',   count: leads.length },
          { kind: 'quotes',  count: quotes.length },
          { kind: 'jobs',    count: jobs.length },
        ]),
        totalPlanned,
        JSON.stringify({ synth_orphan_quotes: synthOrphanQuotes }),
        totalPlanned,
      ]);

    // Plan rows in batches. D1's batch ceiling is ~100 stmts; 50 is safe.
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
      counts: {
        staff: staff.length,
        clients: clients.length,
        leads: leads.length,
        quotes: quotes.length,
        jobs: jobs.length,
      },
      message: 'Full import queued. The cron worker will start processing within ~1 minute. Watch /settings/wfm-import for live progress.',
    });
  } catch (err) {
    // Best-effort: mark the run as failed if we got far enough to insert it.
    try {
      await run(env.DB,
        `UPDATE wfm_import_runs
            SET status = 'failed', finished_at = ?,
                summary = 'failed during planning: ' || ?
          WHERE id = ?`,
        [nowIso(), String(err.message || err), runId]);
    } catch (_) { /* run row may not exist yet */ }
    return json({ ok: false, error: String(err.message || err) }, 500);
  }
}
