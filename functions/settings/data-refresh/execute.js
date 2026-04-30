// functions/settings/data-refresh/execute.js
//
// POST /settings/data-refresh/execute — DESTRUCTIVE.
//
// Body: { keep_account_ids, keep_opp_ids, confirm } where
//   confirm must equal "DELETE EVERYTHING NOT KEPT" (the same
//   phrase the UI prompts for) — guards against accidental fires.
//
// Runs the same plan as /preview, then issues a single batch of
// DELETE statements in dependency order. D1's batch() is
// serialized but not transactional in the strict ACID sense;
// however, the FK RESTRICT relationships make a partial-failure
// state safe to retry: if a step fails, the parent table still
// has the rows, and the user can re-run after addressing the
// problem.
//
// Audit: writes a single 'data_refresh' event under entity_type
// 'system' so the History page records the operation.

import { stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { hasRole } from '../../lib/auth.js';
import { computeRefreshPlan, parseIdList } from '../../lib/data-refresh.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

const CONFIRM_PHRASE = 'DELETE EVERYTHING NOT KEPT';

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user) return json({ ok: false, error: 'unauthenticated' }, 401);
  if (!hasRole(user, 'admin')) return json({ ok: false, error: 'admin_only' }, 403);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  if (body?.confirm !== CONFIRM_PHRASE) {
    return json({ ok: false, error: 'confirm_phrase_required' }, 400);
  }

  const keepAccountIds = parseIdList(body?.keep_account_ids);
  const keepOppIds = parseIdList(body?.keep_opp_ids);

  // Re-compute the plan inside the executor (don't trust the
  // browser's preview blob — recompute from the same inputs).
  let plan;
  try {
    plan = await computeRefreshPlan(env, { keepAccountIds, keepOppIds });
  } catch (err) {
    return json({ ok: false, error: 'plan_failed: ' + (err?.message || err) }, 500);
  }

  if (plan.missingAccountIds.length || plan.missingOppIds.length) {
    return json({
      ok: false,
      error: 'keep_list_has_unknown_ids',
      missing_account_ids: plan.missingAccountIds,
      missing_opp_ids: plan.missingOppIds,
    }, 400);
  }

  // Build the delete batch in dependency order:
  //   change_orders → jobs → opportunities (RESTRICT chain,
  //   pre-delete each manually). opportunities → cascades to
  //   quotes / activities / documents / cost_builds via FK.
  //   accounts → cascades to contacts / addresses.
  const stmts = [];
  const total = {
    change_orders: plan.deleteCoIds.length,
    jobs: plan.deleteJobIds.length,
    opportunities: plan.deleteOppIds.length,
    accounts: plan.deleteAccountIds.length,
    quotes: plan.cascadeCounts.quotes,
    quote_lines: plan.cascadeCounts.quote_lines,
    cost_builds: plan.cascadeCounts.cost_builds,
    activities: plan.cascadeCounts.activities,
    documents: plan.cascadeCounts.documents,
    contacts: plan.cascadeCounts.contacts,
    account_addresses: plan.cascadeCounts.account_addresses,
  };

  // Audit event BEFORE the deletes so the tombstone survives.
  // Uses 'system' entityType + a fixed id so successive refreshes
  // accumulate in the history page in chronological order.
  stmts.push(auditStmt(env.DB, {
    entityType: 'system',
    entityId: 'data_refresh',
    eventType: 'data_refresh',
    user,
    summary: 'Data refresh: kept ' + plan.extendedKeepAccountIds.length
      + ' account(s) + ' + plan.keepOppIds.length + ' opp(s); deleted '
      + total.accounts + ' accounts, ' + total.opportunities + ' opps, '
      + total.jobs + ' jobs, ' + total.change_orders + ' change orders',
    changes: {
      keep_account_ids: keepAccountIds,
      keep_opp_ids: keepOppIds,
      auto_kept_account_count: plan.autoKeptAccountCount,
      delete_counts: total,
    },
  }));

  if (plan.deleteCoIds.length > 0) {
    stmts.push(stmt(env.DB,
      `DELETE FROM change_orders WHERE id IN
         (${plan.deleteCoIds.map(() => '?').join(',')})`,
      plan.deleteCoIds));
  }
  if (plan.deleteJobIds.length > 0) {
    stmts.push(stmt(env.DB,
      `DELETE FROM jobs WHERE id IN
         (${plan.deleteJobIds.map(() => '?').join(',')})`,
      plan.deleteJobIds));
  }
  if (plan.deleteOppIds.length > 0) {
    stmts.push(stmt(env.DB,
      `DELETE FROM opportunities WHERE id IN
         (${plan.deleteOppIds.map(() => '?').join(',')})`,
      plan.deleteOppIds));
  }
  if (plan.deleteAccountIds.length > 0) {
    stmts.push(stmt(env.DB,
      `DELETE FROM accounts WHERE id IN
         (${plan.deleteAccountIds.map(() => '?').join(',')})`,
      plan.deleteAccountIds));
  }

  if (stmts.length === 1) {
    // Only the audit row — nothing to delete.
    return json({ ok: true, deleted_count: 0, totals: total });
  }

  try {
    await batch(env.DB, stmts);
  } catch (err) {
    return json({
      ok: false,
      error: 'batch_failed: ' + (err?.message || String(err)),
    }, 500);
  }

  const deletedCount = Object.values(total).reduce((s, n) => s + n, 0);
  return json({ ok: true, deleted_count: deletedCount, totals: total });
}
