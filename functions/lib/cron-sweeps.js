// functions/lib/cron-sweeps.js
//
// Auto-tasks Phase 2 — scheduled sweep implementations.
//
// Four time-based triggers live here. Each sweep is a small function
// that queries D1 for candidate rows, then calls fireEvent() per row so
// the normal rules engine handles the fan-out. Nothing creates tasks
// directly — every task must come from an editable task_rules row.
//
// Windowing:
//   Each sweep uses a UTC-day bucket (YYYY-MM-DD). The cron_runs table
//   (migration 0037) has UNIQUE (sweep_key, window_start), so attempting
//   to insert the same (sweep_key, day) twice returns a conflict and we
//   exit early — safe to call the /api/cron/sweep endpoint multiple
//   times per day.
//
//   The rules engine *also* dedupes per-rule via task_rule_fires
//   UNIQUE (rule_id, event_key), so even without the cron_runs gate
//   we'd never double-create a task.
//
// Adding a new sweep:
//   1. Append a new sweep function here following the pattern below.
//   2. Register it in runAllSweeps() at the bottom.
//   3. Add the trigger key + schema hints to settings/auto-tasks
//      (index.js TRIGGERS + rule-schema.js CONDITION_PATHS/TOKEN_PATHS).

import { all } from './db.js';
import { now } from './ids.js';
import { fireEvent } from './auto-tasks.js';

// ---------------------------------------------------------------------
// Window helpers
// ---------------------------------------------------------------------

/** Today's bucket key in UTC (YYYY-MM-DD). */
export function todayBucketUtc(clock = Date) {
  const d = new clock();
  return d.toISOString().slice(0, 10);
}

/**
 * Start a sweep window. Inserts a cron_runs row — if the (sweep_key,
 * window_start) pair already exists, returns null (caller should skip
 * the sweep). Otherwise returns { bucket, startedAt } which the caller
 * uses to stamp results via finishSweep().
 */
export async function startSweep(db, sweepKey, bucket) {
  const startedAt = now();
  try {
    await db
      .prepare(
        `INSERT INTO cron_runs (sweep_key, window_start, started_at)
         VALUES (?, ?, ?)`
      )
      .bind(sweepKey, bucket, startedAt)
      .run();
    return { bucket, startedAt };
  } catch (err) {
    // SQLite UNIQUE constraint failure — already ran this window.
    if (/UNIQUE/i.test(err?.message || '')) {
      return null;
    }
    throw err;
  }
}

/** Stamp a sweep row with counts + finished_at. */
export async function finishSweep(db, sweepKey, bucket, { fired, skipped, error }) {
  try {
    await db
      .prepare(
        `UPDATE cron_runs
            SET finished_at = ?, fired_count = ?, skipped_count = ?, error = ?
          WHERE sweep_key = ? AND window_start = ?`
      )
      .bind(now(), fired ?? 0, skipped ?? 0, error ?? null, sweepKey, bucket)
      .run();
  } catch (err) {
    console.error('cron finishSweep failed:', err?.message || err);
  }
}

// ---------------------------------------------------------------------
// Individual sweeps
// ---------------------------------------------------------------------

/**
 * Find quotes expiring within `windowDays` days (default 7) and fire
 * quote.expiring_soon. Rules bound to this trigger can create reminder
 * tasks like "Follow up with {account.name} before {quote.number} expires".
 */
export async function sweepQuotesExpiringSoon(env, { windowDays = 7 } = {}) {
  const bucket = todayBucketUtc();
  const lock = await startSweep(env.DB, 'quote.expiring_soon', bucket);
  if (!lock) return { bucket, fired: 0, skipped: 0, skippedReason: 'already_ran' };

  let fired = 0;
  let skipped = 0;

  try {
    const today = new Date();
    const horizonIso = new Date(today.getTime() + windowDays * 86400_000)
      .toISOString()
      .slice(0, 10);
    const todayIso = today.toISOString().slice(0, 10);

    const rows = await all(
      env.DB,
      `SELECT q.*,
              o.id   AS _opp_id,
              o.number AS opp_number,
              o.title AS opp_title,
              o.stage AS opp_stage,
              o.transaction_type AS opp_transaction_type,
              o.owner_user_id AS opp_owner_user_id,
              a.id   AS account_id,
              a.name AS account_name,
              a.alias AS account_alias
         FROM quotes q
         JOIN opportunities o ON o.id = q.opportunity_id
         LEFT JOIN accounts a ON a.id = o.account_id
        WHERE q.status IN ('issued', 'revision_issued')
          AND q.valid_until IS NOT NULL
          AND q.valid_until <= ?
          AND q.valid_until >= ?`,
      [horizonIso, todayIso]
    );

    for (const r of rows) {
      const validUntil = new Date(r.valid_until + 'T00:00:00Z').getTime();
      const daysUntilExpire = Math.round(
        (validUntil - Date.parse(todayIso + 'T00:00:00Z')) / 86400_000
      );
      const payload = {
        trigger: { user: null, at: now() },
        quote: r,
        opportunity: {
          id: r._opp_id,
          number: r.opp_number,
          title: r.opp_title,
          stage: r.opp_stage,
          transaction_type: r.opp_transaction_type,
          owner_user_id: r.opp_owner_user_id,
        },
        account: r.account_id
          ? { id: r.account_id, name: r.account_name, alias: r.account_alias }
          : null,
        days_until_expire: daysUntilExpire,
      };
      payload.bucket = bucket;
      const res = await fireEvent(env, 'quote.expiring_soon', payload, null);
      fired += res?.fired ?? 0;
      skipped += res?.skipped ?? 0;
    }
  } catch (err) {
    await finishSweep(env.DB, 'quote.expiring_soon', bucket, {
      fired, skipped, error: err?.message || String(err),
    });
    throw err;
  }

  await finishSweep(env.DB, 'quote.expiring_soon', bucket, { fired, skipped });
  return { bucket, fired, skipped };
}

/**
 * Find pending tasks past their due date and fire task.overdue.
 */
export async function sweepTasksOverdue(env) {
  const bucket = todayBucketUtc();
  const lock = await startSweep(env.DB, 'task.overdue', bucket);
  if (!lock) return { bucket, fired: 0, skipped: 0, skippedReason: 'already_ran' };

  let fired = 0;
  let skipped = 0;

  try {
    const todayIso = new Date().toISOString().slice(0, 10);
    const rows = await all(
      env.DB,
      `SELECT t.*,
              o.id AS _opp_id, o.number AS opp_number, o.title AS opp_title,
              o.stage AS opp_stage, o.transaction_type AS opp_transaction_type,
              o.owner_user_id AS opp_owner_user_id,
              a.id AS account_id, a.name AS account_name, a.alias AS account_alias
         FROM activities t
         LEFT JOIN opportunities o ON o.id = t.opportunity_id
         LEFT JOIN accounts a ON a.id = COALESCE(o.account_id, t.account_id)
        WHERE t.type = 'task'
          AND t.status = 'pending'
          AND t.due_at IS NOT NULL
          AND t.due_at < ?`,
      [todayIso]
    );

    for (const r of rows) {
      const due = new Date(r.due_at + 'T00:00:00Z').getTime();
      const daysOverdue = Math.max(
        1,
        Math.round((Date.parse(todayIso + 'T00:00:00Z') - due) / 86400_000)
      );
      const payload = {
        trigger: { user: null, at: now() },
        task: {
          id: r.id,
          type: r.type,
          subject: r.subject,
          status: r.status,
          due_at: r.due_at,
          assigned_user_id: r.assigned_user_id,
          opportunity_id: r.opportunity_id,
        },
        opportunity: r._opp_id
          ? {
              id: r._opp_id, number: r.opp_number, title: r.opp_title,
              stage: r.opp_stage, transaction_type: r.opp_transaction_type,
              owner_user_id: r.opp_owner_user_id,
            }
          : null,
        account: r.account_id
          ? { id: r.account_id, name: r.account_name, alias: r.account_alias }
          : null,
        days_overdue: daysOverdue,
      };
      payload.bucket = bucket;
      const res = await fireEvent(env, 'task.overdue', payload, null);
      fired += res?.fired ?? 0;
      skipped += res?.skipped ?? 0;
    }
  } catch (err) {
    await finishSweep(env.DB, 'task.overdue', bucket, {
      fired, skipped, error: err?.message || String(err),
    });
    throw err;
  }

  await finishSweep(env.DB, 'task.overdue', bucket, { fired, skipped });
  return { bucket, fired, skipped };
}

/**
 * Find opportunities that haven't moved in `stalledDays` (default 30)
 * and aren't already closed. Fire opportunity.stalled.
 */
export async function sweepOpportunitiesStalled(env, { stalledDays = 30 } = {}) {
  const bucket = todayBucketUtc();
  const lock = await startSweep(env.DB, 'opportunity.stalled', bucket);
  if (!lock) return { bucket, fired: 0, skipped: 0, skippedReason: 'already_ran' };

  let fired = 0;
  let skipped = 0;

  try {
    const cutoff = new Date(Date.now() - stalledDays * 86400_000).toISOString();
    const rows = await all(
      env.DB,
      `SELECT o.*,
              a.id AS account_id, a.name AS account_name, a.alias AS account_alias
         FROM opportunities o
         LEFT JOIN accounts a ON a.id = o.account_id
        WHERE o.updated_at < ?
          AND o.stage NOT IN ('closed_won', 'closed_lost', 'closed_died', 'closed_abandoned')`,
      [cutoff]
    );

    for (const r of rows) {
      const daysStalled = Math.round(
        (Date.now() - Date.parse(r.updated_at)) / 86400_000
      );
      const payload = {
        trigger: { user: null, at: now() },
        opportunity: r,
        account: r.account_id
          ? { id: r.account_id, name: r.account_name, alias: r.account_alias }
          : null,
        days_stalled: daysStalled,
      };
      payload.bucket = bucket;
      const res = await fireEvent(env, 'opportunity.stalled', payload, null);
      fired += res?.fired ?? 0;
      skipped += res?.skipped ?? 0;
    }
  } catch (err) {
    await finishSweep(env.DB, 'opportunity.stalled', bucket, {
      fired, skipped, error: err?.message || String(err),
    });
    throw err;
  }

  await finishSweep(env.DB, 'opportunity.stalled', bucket, { fired, skipped });
  return { bucket, fired, skipped };
}

/**
 * Find price builds linked to still-live quotes that haven't been
 * updated in `staleDays` days. Fire price_build.stale.
 */
export async function sweepPriceBuildsStale(env, { staleDays = 30 } = {}) {
  const bucket = todayBucketUtc();
  const lock = await startSweep(env.DB, 'price_build.stale', bucket);
  if (!lock) return { bucket, fired: 0, skipped: 0, skippedReason: 'already_ran' };

  let fired = 0;
  let skipped = 0;

  try {
    const cutoff = new Date(Date.now() - staleDays * 86400_000).toISOString();
    const rows = await all(
      env.DB,
      `SELECT cb.id AS cost_build_id, cb.label, cb.status AS cost_build_status,
              cb.updated_at AS cost_build_updated_at,
              q.id AS quote_id, q.number AS quote_number, q.title AS quote_title,
              q.quote_type AS quote_type, q.status AS quote_status,
              o.id AS opportunity_id, o.number AS opp_number, o.title AS opp_title,
              o.stage AS opp_stage, o.transaction_type AS opp_transaction_type,
              o.owner_user_id AS opp_owner_user_id,
              a.id AS account_id, a.name AS account_name, a.alias AS account_alias
         FROM cost_builds cb
         JOIN quotes q ON q.cost_build_id = cb.id
         JOIN opportunities o ON o.id = q.opportunity_id
         LEFT JOIN accounts a ON a.id = o.account_id
        WHERE cb.updated_at < ?
          AND q.status IN ('draft', 'revision_draft', 'issued', 'revision_issued', 'internal_review', 'approved_internal')`,
      [cutoff]
    );

    for (const r of rows) {
      const daysStale = Math.round(
        (Date.now() - Date.parse(r.cost_build_updated_at)) / 86400_000
      );
      const payload = {
        trigger: { user: null, at: now() },
        cost_build: {
          id: r.cost_build_id,
          label: r.label,
          status: r.cost_build_status,
          updated_at: r.cost_build_updated_at,
        },
        quote: {
          id: r.quote_id, number: r.quote_number, title: r.quote_title,
          quote_type: r.quote_type, status: r.quote_status,
        },
        opportunity: {
          id: r.opportunity_id, number: r.opp_number, title: r.opp_title,
          stage: r.opp_stage, transaction_type: r.opp_transaction_type,
          owner_user_id: r.opp_owner_user_id,
        },
        account: r.account_id
          ? { id: r.account_id, name: r.account_name, alias: r.account_alias }
          : null,
        days_stale: daysStale,
      };
      payload.bucket = bucket;
      const res = await fireEvent(env, 'price_build.stale', payload, null);
      fired += res?.fired ?? 0;
      skipped += res?.skipped ?? 0;
    }
  } catch (err) {
    await finishSweep(env.DB, 'price_build.stale', bucket, {
      fired, skipped, error: err?.message || String(err),
    });
    throw err;
  }

  await finishSweep(env.DB, 'price_build.stale', bucket, { fired, skipped });
  return { bucket, fired, skipped };
}

// ---------------------------------------------------------------------
// Top-level orchestrator
// ---------------------------------------------------------------------

/**
 * Run every registered sweep in sequence. Failures in one sweep don't
 * block later sweeps — we capture the error message in the per-sweep
 * result and keep going. Returns a summary object the endpoint can
 * serialize back to the caller for observability.
 */
export async function runAllSweeps(env) {
  const results = {};
  const sweeps = [
    ['quote.expiring_soon',  () => sweepQuotesExpiringSoon(env)],
    ['task.overdue',         () => sweepTasksOverdue(env)],
    ['opportunity.stalled',  () => sweepOpportunitiesStalled(env)],
    ['price_build.stale',    () => sweepPriceBuildsStale(env)],
  ];
  for (const [key, fn] of sweeps) {
    try {
      results[key] = await fn();
    } catch (err) {
      console.error(`cron sweep ${key} failed:`, err?.message || err);
      results[key] = { error: err?.message || String(err) };
    }
  }
  return results;
}
