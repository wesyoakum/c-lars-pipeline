// functions/lib/data-refresh.js
//
// Helpers for the admin "data refresh" tool: given two keep-lists
// (account IDs + opportunity IDs), compute exactly what would be
// deleted, and execute the deletion in dependency order.
//
// Scope: this nukes the deal-data graph (accounts, opportunities,
// quotes, jobs, change orders, activities, documents, cost builds,
// contacts, addresses) but never touches the system tables —
// users, site_prefs, audit_events, fake_names, governing_documents,
// stage_definitions, auto_task_rules, ai_inbox_*, etc. all stay put.
//
// Dependency-order delete pass:
//
//   change_orders   → REFERENCES jobs(id)            (RESTRICT, manual delete first)
//   jobs            → REFERENCES opportunities(id)   (RESTRICT, manual delete first)
//   opportunities   → REFERENCES accounts(id)        (RESTRICT, manual delete first)
//                     CASCADE children: quotes, cost_builds, activities, documents
//   accounts        → CASCADE children: contacts, account_addresses
//
// We also auto-extend the keep-account-list to include the parent
// account of every kept opportunity. Otherwise the user could ask
// to keep an opp whose account is in the delete list — the FK
// would block, the whole transaction would roll back, and the user
// would have a confusing error.

import { all } from './db.js';

/**
 * Parse a free-text textarea blob into a deduped array of trimmed,
 * non-empty IDs. Tolerates one-per-line, comma-separated, or both.
 * Strips whitespace, surrounding quotes, and the common case of
 * pasted Markdown bullets ("- abc", "* abc").
 */
export function parseIdList(text) {
  if (!text || typeof text !== 'string') return [];
  const seen = new Set();
  const out = [];
  for (const raw of text.split(/[\s,]+/)) {
    let v = raw.trim();
    if (!v) continue;
    // Strip leading bullet / numbering noise.
    v = v.replace(/^[-*•]+\s*/, '');
    // Strip surrounding quotes.
    v = v.replace(/^["']|["']$/g, '');
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * Given the explicit keep-lists, compute the full set of IDs that
 * would be deleted across every affected table. Returns counts +
 * the actual ID arrays (so the executor can run the same logic
 * without re-querying).
 */
export async function computeRefreshPlan(env, { keepAccountIds, keepOppIds }) {
  // Auto-extend kept accounts to include the parent of every kept
  // opp. Without this, deleting that account would FK-block.
  let extendedKeepAccountIds = keepAccountIds.slice();
  if (keepOppIds.length > 0) {
    const parentRows = await all(env.DB,
      `SELECT DISTINCT account_id FROM opportunities
        WHERE id IN (${keepOppIds.map(() => '?').join(',')})
          AND account_id IS NOT NULL`,
      keepOppIds);
    const parents = parentRows.map(r => r.account_id);
    const seen = new Set(extendedKeepAccountIds);
    for (const p of parents) {
      if (!seen.has(p)) {
        seen.add(p);
        extendedKeepAccountIds.push(p);
      }
    }
  }

  // Validate the explicit keep IDs actually exist (so the user
  // doesn't silently typo and lose everything). Non-existent IDs
  // are reported back so the user can fix before executing.
  const missingAccountIds = await missingFromTable(
    env.DB, 'accounts', keepAccountIds);
  const missingOppIds = await missingFromTable(
    env.DB, 'opportunities', keepOppIds);

  // Compute the delete sets.
  const deleteOppIds = await idsExcluding(
    env.DB, 'opportunities', keepOppIds);
  const deleteAccountIds = await idsExcluding(
    env.DB, 'accounts', extendedKeepAccountIds);

  // Children of deleted opps (jobs RESTRICT, COs RESTRICT).
  const deleteJobIds = deleteOppIds.length > 0
    ? (await all(env.DB,
        `SELECT id FROM jobs WHERE opportunity_id IN
           (${deleteOppIds.map(() => '?').join(',')})`,
        deleteOppIds)).map(r => r.id)
    : [];
  const deleteCoIds = deleteJobIds.length > 0
    ? (await all(env.DB,
        `SELECT id FROM change_orders WHERE job_id IN
           (${deleteJobIds.map(() => '?').join(',')})`,
        deleteJobIds)).map(r => r.id)
    : [];

  // Cascading children — counts only (the actual DELETE happens
  // via FK CASCADE so we don't list IDs).
  const cascadeCounts = await cascadeChildCounts(env.DB, {
    deleteOppIds,
    deleteJobIds,
    deleteAccountIds,
  });

  return {
    keepAccountIds,
    keepOppIds,
    extendedKeepAccountIds,
    autoKeptAccountCount: extendedKeepAccountIds.length - keepAccountIds.length,
    missingAccountIds,
    missingOppIds,
    deleteOppIds,
    deleteAccountIds,
    deleteJobIds,
    deleteCoIds,
    cascadeCounts,
  };
}

async function missingFromTable(db, table, ids) {
  if (ids.length === 0) return [];
  const rows = await all(db,
    `SELECT id FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids);
  const present = new Set(rows.map(r => r.id));
  return ids.filter(id => !present.has(id));
}

async function idsExcluding(db, table, keepIds) {
  if (keepIds.length === 0) {
    return (await all(db, `SELECT id FROM ${table}`, [])).map(r => r.id);
  }
  const rows = await all(db,
    `SELECT id FROM ${table} WHERE id NOT IN
       (${keepIds.map(() => '?').join(',')})`,
    keepIds);
  return rows.map(r => r.id);
}

async function cascadeChildCounts(db, { deleteOppIds, deleteJobIds, deleteAccountIds }) {
  const counts = {
    quotes: 0, quote_lines: 0, cost_builds: 0, activities: 0,
    documents: 0, contacts: 0, account_addresses: 0,
  };
  if (deleteOppIds.length > 0) {
    const ph = deleteOppIds.map(() => '?').join(',');
    counts.quotes        = await scalar(db, `SELECT COUNT(*) AS n FROM quotes WHERE opportunity_id IN (${ph})`, deleteOppIds);
    counts.cost_builds   = await scalar(db, `SELECT COUNT(*) AS n FROM cost_builds WHERE opportunity_id IN (${ph})`, deleteOppIds);
    counts.activities   += await scalar(db, `SELECT COUNT(*) AS n FROM activities WHERE opportunity_id IN (${ph})`, deleteOppIds);
    counts.documents    += await scalar(db, `SELECT COUNT(*) AS n FROM documents WHERE opportunity_id IN (${ph})`, deleteOppIds);
    // quote_lines cascade through quotes, so count via the join.
    counts.quote_lines   = await scalar(db,
      `SELECT COUNT(*) AS n FROM quote_lines ql
         JOIN quotes q ON q.id = ql.quote_id
        WHERE q.opportunity_id IN (${ph})`, deleteOppIds);
  }
  if (deleteJobIds.length > 0) {
    const ph = deleteJobIds.map(() => '?').join(',');
    counts.activities   += await scalar(db, `SELECT COUNT(*) AS n FROM activities WHERE job_id IN (${ph})`, deleteJobIds);
    counts.documents    += await scalar(db, `SELECT COUNT(*) AS n FROM documents WHERE job_id IN (${ph})`, deleteJobIds);
  }
  if (deleteAccountIds.length > 0) {
    const ph = deleteAccountIds.map(() => '?').join(',');
    counts.contacts          = await scalar(db, `SELECT COUNT(*) AS n FROM contacts WHERE account_id IN (${ph})`, deleteAccountIds);
    counts.account_addresses = await scalar(db, `SELECT COUNT(*) AS n FROM account_addresses WHERE account_id IN (${ph})`, deleteAccountIds);
    counts.activities       += await scalar(db, `SELECT COUNT(*) AS n FROM activities WHERE account_id IN (${ph})`, deleteAccountIds);
    counts.documents        += await scalar(db, `SELECT COUNT(*) AS n FROM documents WHERE account_id IN (${ph})`, deleteAccountIds);
  }
  return counts;
}

async function scalar(db, sql, params) {
  const rows = await all(db, sql, params);
  return rows[0]?.n ?? 0;
}
