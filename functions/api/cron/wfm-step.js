// functions/api/cron/wfm-step.js
//
// POST /api/cron/wfm-step
//
// Background full-import step processor. Fired every minute by the
// sidecar cron Worker (see workers/cron/src/index.js).
//
// Each tick:
//   1. Find the latest in-progress full-import run.
//   2. Pick up a chunk of pending plan rows (oldest sequence first).
//   3. Mark them processing.
//   4. Build a samples object grouped by kind, call processSamples()
//      from commit.js — same engine as selective imports.
//   5. Mark the plans done/error based on result.
//   6. UPDATE the wfm_import_runs row with rolling count totals,
//      latest summary, and accumulated error list.
//   7. If no plans remain pending, mark run as completed.
//
// Auth: requires x-cron-secret header (same as /api/cron/sweep).
// /_middleware.js bypasses Cloudflare Access for /api/cron/* paths.
//
// Wall-clock budget per tick: ~25s (Pages Functions cap is 30s). The
// chunk size is tuned so a typical chunk finishes well under that
// budget. If we run long, we just stop the chunk early — remaining
// pending plans get picked up by the next tick.

import { all, one, run, stmt, batch } from '../../lib/db.js';
import { processSamples, buildSummaryLine } from '../../settings/wfm-import/commit.js';
import { notify } from '../../lib/notify.js';
import { notifyExternal, NOTIFICATION_EVENTS } from '../../lib/notify-external.js';

// Per-tick budget: stop kicking off new sub-batches once we've used
// this much wall clock. Each commit.processSamples invocation can
// take 10–20s for a small chunk because of per-record detail calls
// to WFM. Leave 5s headroom under the 30s ceiling.
const TICK_BUDGET_MS = 25_000;

// Chunk shape per call to processSamples. Tuned for the WFM rate
// limit (60 calls/min) and the per-record detail-fetch cost.
const CHUNK_SIZE_BY_KIND = {
  staff:   30,    // no per-record detail calls
  client:  10,    // each does /client.api/get for contacts
  lead:    25,
  quote:   10,    // each does /quote.api/get for line items
  job:     20,
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function unauthorized() { return new Response('Unauthorized', { status: 401 }); }
function nowIso()       { return new Date().toISOString(); }

// Constant-time compare (mirrors sweep.js).
function checkSecret(request, env) {
  const provided = request.headers.get('x-cron-secret') || '';
  const expected = env.CRON_SECRET || '';
  if (!expected) return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

// Convert an array of plan rows into a samples object the engine
// understands (plural keys: clients/leads/quotes/jobs/staff).
function buildSamplesFromPlans(plans) {
  const out = { staff: [], clients: [], leads: [], quotes: [], jobs: [] };
  const PLURAL = { staff: 'staff', client: 'clients', lead: 'leads', quote: 'quotes', job: 'jobs' };
  for (const p of plans) {
    const plural = PLURAL[p.kind];
    if (!plural) continue;
    let rec;
    try { rec = JSON.parse(p.record_json); } catch { continue; }
    out[plural].push(rec);
  }
  return out;
}

// Bump the wfm_import_runs row's accumulated counters and summary.
// Idempotent in the sense that this just overwrites fields with
// freshly computed values (the in-memory totals are tracked across
// chunks within a single tick).
async function updateRunProgress(env, runId, totals, errors, links) {
  await run(env.DB,
    `UPDATE wfm_import_runs
        SET counts_json = ?,
            errors_json = ?,
            links_json  = ?,
            summary     = ?,
            updated_at  = ?
      WHERE id = ?`,
    [
      JSON.stringify(totals),
      JSON.stringify(errors.slice(-200)),    // keep the most-recent 200 error lines
      JSON.stringify(links.slice(-200)),     // and the most-recent 200 imported links
      buildSummaryLine(totals),
      nowIso(),
      runId,
    ]);
}

// Mark plan rows by id with a new status (and optional error message).
async function markPlans(env, ids, status, errorMessage = null) {
  if (ids.length === 0) return;
  const ts = nowIso();
  const finishedAt = (status === 'done' || status === 'error') ? ts : null;
  // SQLite's IN (?, ?, ...) requires us to expand placeholders.
  for (const chunkOfIds of chunked(ids, 50)) {
    const placeholders = chunkOfIds.map(() => '?').join(',');
    await run(env.DB,
      'UPDATE wfm_import_plans SET status = ?, error_message = ?, finished_at = ?, updated_at = ? ' +
      'WHERE id IN (' + placeholders + ')',
      [status, errorMessage, finishedAt, ts, ...chunkOfIds]);
  }
}

function chunked(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export async function onRequestPost(context) {
  const { env, request } = context;

  if (!checkSecret(request, env)) return unauthorized();

  const tickStart = Date.now();

  try {
    // 1. Find the latest in-progress full-import run.
    const runRow = await one(env.DB,
      `SELECT id, options_json, counts_json, errors_json, links_json,
              triggered_by, started_at
         FROM wfm_import_runs
        WHERE mode = 'full' AND status = 'in_progress'
        ORDER BY started_at DESC
        LIMIT 1`);
    if (!runRow) {
      return json({ ok: true, no_run: true, message: 'No in-progress full-import run.' });
    }
    const runId = runRow.id;
    const options = (() => { try { return JSON.parse(runRow.options_json || '{}'); } catch { return {}; } })();

    // 2. Reload accumulated state from the run row.
    const totals = (() => { try { return JSON.parse(runRow.counts_json || '{}'); } catch { return {}; } })();
    const errors = (() => { try { return JSON.parse(runRow.errors_json || '[]'); } catch { return []; } })();
    const links  = (() => { try { return JSON.parse(runRow.links_json  || '[]'); } catch { return []; } })();

    // 3. Loop sub-chunks until we run out of pending plans OR run
    //    out of tick budget. One sub-chunk per kind, staying within
    //    that kind's tuned chunk size.
    let chunksProcessed = 0;
    let lastKindWorked  = null;

    while (Date.now() - tickStart < TICK_BUDGET_MS) {
      // Find the next pending plan row to determine which kind we're
      // working on. Process all plans of that kind in chunk-size
      // groups before moving on (cascade efficiency).
      const next = await one(env.DB,
        `SELECT kind FROM wfm_import_plans
          WHERE run_id = ? AND status = 'pending'
          ORDER BY sequence ASC LIMIT 1`,
        [runId]);
      if (!next) break;   // no more work — run is done
      const kind = next.kind;
      lastKindWorked = kind;
      const chunkSize = CHUNK_SIZE_BY_KIND[kind] || 20;

      const planChunk = await all(env.DB,
        `SELECT id, kind, external_uuid, record_json
           FROM wfm_import_plans
          WHERE run_id = ? AND status = 'pending' AND kind = ?
          ORDER BY sequence ASC LIMIT ?`,
        [runId, kind, chunkSize]);
      if (planChunk.length === 0) break;

      // Mark them processing first (so a concurrent tick can't
      // double-pick — though crons aren't concurrent in our setup,
      // this also makes status visible mid-tick).
      await markPlans(env, planChunk.map((p) => p.id), 'processing');

      const samples = buildSamplesFromPlans(planChunk);

      let chunkResult;
      try {
        chunkResult = await processSamples(env, samples, options);
      } catch (engineErr) {
        const msg = String(engineErr.message || engineErr);

        // Special case: OAuth chain is dead. Don't mark plans as
        // 'error' (they're not record-level failures — just unable
        // to reach WFM). Roll the chunk back to 'pending' so they
        // resume cleanly once the user reconnects, and log a
        // single error line on the run so the UI surfaces what
        // happened. The cron keeps firing every minute but each
        // tick is cheap (one D1 read + one OAuth refresh attempt)
        // until OAuth is repaired.
        const isOauthFailure = /OAuth token refresh failed|invalid_grant|Refresh token (?:is invalid|reuse detected|has expired)|RECONNECT[ _]REQUIRED|WFM is not connected/i
          .test(msg);
        if (isOauthFailure) {
          await markPlans(env, planChunk.map((p) => p.id), 'pending');
          // Append the error only once per tick to avoid a log
          // explosion across many tries.
          const recentError = 'WFM OAuth chain is dead — paused until reconnected. Visit /settings/wfm-import → Reconnect.';
          if (errors[errors.length - 1] !== recentError) errors.push(recentError);
          await updateRunProgress(env, runId, totals, errors, links);
          // Bail out of the tick — no point trying further chunks
          // until OAuth is repaired.
          return json({
            ok: false,
            run_id: runId,
            paused_for_oauth: true,
            chunks_processed: chunksProcessed,
            duration_ms: Date.now() - tickStart,
          }, 200);  // 200 because the cron is fine — it's WFM that's down
        }

        // Any other engine error: real per-chunk failure. Mark
        // the plans as 'error' so the user can see them in the UI.
        await markPlans(env, planChunk.map((p) => p.id), 'error', msg);
        errors.push('chunk ' + kind + ' (' + planChunk.length + ' records) failed: ' + msg);
        await updateRunProgress(env, runId, totals, errors, links);
        chunksProcessed++;
        continue;
      }

      // Roll chunk counts into accumulated totals.
      for (const k of Object.keys(chunkResult.counts)) {
        totals[k] = (totals[k] || 0) + chunkResult.counts[k];
      }
      for (const e of chunkResult.errors) errors.push(e);
      for (const l of chunkResult.links)  links.push(l);

      // Mark all plans in this chunk as done (the engine doesn't
      // tell us which records succeeded individually — successful
      // ones land in DB, errored ones are surfaced via chunkResult.errors
      // and the records may not be saved. For now we mark all as
      // done; the per-record errors are still visible in the run row).
      await markPlans(env, planChunk.map((p) => p.id), 'done');

      await updateRunProgress(env, runId, totals, errors, links);
      chunksProcessed++;
    }

    // 4. Check for completion. If no pending plans remain (and we
    //    didn't bail because of budget), the run is done.
    const pendingLeft = await one(env.DB,
      `SELECT COUNT(*) AS n FROM wfm_import_plans
        WHERE run_id = ? AND status IN ('pending', 'processing')`,
      [runId]);
    if (pendingLeft && pendingLeft.n === 0) {
      const finishedAt = nowIso();
      await run(env.DB,
        `UPDATE wfm_import_runs
            SET status = 'completed', finished_at = ?, ok = 1,
                summary = ?, counts_json = ?, errors_json = ?,
                links_json = ?, updated_at = ?
          WHERE id = ?`,
        [
          finishedAt,
          buildSummaryLine(totals),
          JSON.stringify(totals),
          JSON.stringify(errors.slice(-200)),
          JSON.stringify(links.slice(-200)),
          finishedAt,
          runId,
        ]);

      // Ping the user who started the run via two complementary
      // channels:
      //   1. notify() → in-app notifications row (bell icon, top
      //      right). Always fires — no per-user opt-in required.
      //   2. notifyExternal() → Teams webhook + email per the
      //      user's prefs in /settings/notifications. Fires only
      //      if the user has the wfm_full_import_done event enabled
      //      on at least one channel and has configured a target.
      // Both are best-effort — failures are swallowed (notify())
      // or logged to notification_log (notifyExternal()) and don't
      // undo the run-completion.
      if (runRow.triggered_by) {
        const userRow = await one(env.DB,
          'SELECT id FROM users WHERE LOWER(email) = LOWER(?)',
          [runRow.triggered_by]);
        if (userRow && userRow.id) {
          const errorCount = errors.length;
          const summaryLine = buildSummaryLine(totals);
          const inAppBody = summaryLine +
            (errorCount > 0 ? ' — ' + errorCount + ' error(s) recorded.' : '');

          // 1. In-app bell.
          await notify(env.DB, {
            userId:     userRow.id,
            type:       'wfm_full_import_done',
            title:      'WFM full import complete',
            body:       inAppBody,
            linkUrl:    '/settings/wfm-import',
            entityType: 'wfm_import_run',
            entityId:   runId,
          });

          // 2. Teams + email per user prefs.
          try {
            await notifyExternal(env, {
              userId:     userRow.id,
              actorUserId: null,        // cron-triggered, system event
              eventType:  NOTIFICATION_EVENTS.WFM_FULL_IMPORT_DONE,
              data: {
                status:           'completed',
                summary:          summaryLine,
                total_processed:  Object.keys(totals).reduce((s, k) =>
                  ['accounts','contacts','opportunities','quotes','jobs','users']
                    .includes(k) ? s + (totals[k] || 0) : s, 0),
                error_count:      errorCount,
                started_at:       runRow.started_at,
                finished_at:      finishedAt,
                link:             '/settings/wfm-import',
              },
              context: { ref_type: 'wfm_import_run', ref_id: runId },
              idempotencyKey: 'wfm-full-import-done:' + runId,
            });
          } catch (extErr) {
            // notifyExternal swallows its own errors; this catch is
            // a paranoia belt — if the dispatcher itself blew up,
            // the run is still completed and the in-app bell fired.
            console.error('notifyExternal failed:', extErr?.message || extErr);
          }
        }
      }
    }

    return json({
      ok: true,
      run_id: runId,
      chunks_processed: chunksProcessed,
      last_kind: lastKindWorked,
      pending_remaining: pendingLeft ? pendingLeft.n : 0,
      duration_ms: Date.now() - tickStart,
    });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err), duration_ms: Date.now() - tickStart }, 500);
  }
}
