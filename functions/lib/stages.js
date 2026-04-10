// functions/lib/stages.js
//
// Stage catalog lookups + gate rule engine.
//
// The stage catalog lives in the stage_definitions table and is loaded
// once per request and cached in a module-level Map for the lifetime of
// the Worker isolate. Gate rules are evaluated against an opportunity
// and its related rows (accounts, contacts, quotes, cost_builds, jobs)
// and return { allowed: boolean, violations: [{check, severity, message}] }.
//
// TODO(M3 / M7): load gate_rules_json, implement checks listed below:
//   has_account_and_contact, has_cost_build, has_cost_build_locked,
//   has_quote_in_status:<status>, has_bant_fields, has_valid_until_set,
//   has_delivery_terms_set, has_payment_terms_set,
//   has_governance_revisions_snapshotted, has_customer_po, has_oc_data
//
// P0 scaffolding only: exports an empty check table and a passthrough
// evaluator so imports elsewhere don't break.

import { all, one } from './db.js';

let _catalogCache = null;

export async function loadStageCatalog(db) {
  if (_catalogCache) return _catalogCache;
  const rows = await all(
    db,
    `SELECT transaction_type, stage_key, label, sort_order, default_probability,
            is_terminal, is_won, gate_rules_json
       FROM stage_definitions
      ORDER BY transaction_type, sort_order`
  );
  const byType = new Map();
  for (const row of rows) {
    if (!byType.has(row.transaction_type)) byType.set(row.transaction_type, []);
    byType.get(row.transaction_type).push({
      ...row,
      gate_rules: row.gate_rules_json ? JSON.parse(row.gate_rules_json) : null,
    });
  }
  _catalogCache = byType;
  return byType;
}

export function clearStageCatalogCache() {
  _catalogCache = null;
}

/**
 * Get the ordered list of stages for a transaction_type.
 */
export async function stagesFor(db, transactionType) {
  const catalog = await loadStageCatalog(db);
  return catalog.get(transactionType) ?? [];
}

/**
 * Look up a single stage definition.
 */
export async function stageDef(db, transactionType, stageKey) {
  const list = await stagesFor(db, transactionType);
  return list.find((s) => s.stage_key === stageKey) ?? null;
}

/**
 * Gate rule registry — mapping check name → async function(ctx) → boolean.
 * Populated in M3/M7. ctx has { db, opportunity, account, contacts, quotes, costBuilds, job }.
 */
export const CHECKS = {
  // eslint-disable-next-line no-unused-vars
  has_account_and_contact: async (ctx) => true, // TODO M3
  has_cost_build: async (ctx) => true,          // TODO M4
  has_cost_build_locked: async (ctx) => true,   // TODO M4
  has_bant_fields: async (ctx) => true,         // TODO M3
  has_valid_until_set: async (ctx) => true,     // TODO M5
  has_delivery_terms_set: async (ctx) => true,  // TODO M5
  has_payment_terms_set: async (ctx) => true,   // TODO M5
  has_governance_revisions_snapshotted: async (ctx) => true, // TODO M5
  has_customer_po: async (ctx) => true,         // TODO M7
  has_oc_data: async (ctx) => true,             // TODO M7
};

/**
 * Evaluate the gate rules for a target stage against an opportunity context.
 * Returns { allowed, violations }. In P0 scaffold, always returns allowed.
 *
 * TODO(M7): wire into POST /opportunities/:id/stage with override_reason support.
 */
export async function evaluateGate(db, transactionType, targetStageKey, ctx) {
  const def = await stageDef(db, transactionType, targetStageKey);
  if (!def || !def.gate_rules?.requires) {
    return { allowed: true, violations: [] };
  }
  const violations = [];
  for (const rule of def.gate_rules.requires) {
    const checkFn = CHECKS[rule.check];
    if (!checkFn) continue;
    const ok = await checkFn(ctx);
    if (!ok) {
      violations.push({
        check: rule.check,
        severity: rule.severity ?? 'soft',
        message: `Gate check failed: ${rule.check}`,
      });
    }
  }
  const hardFail = violations.some((v) => v.severity === 'hard');
  return { allowed: !hardFail, violations };
}
