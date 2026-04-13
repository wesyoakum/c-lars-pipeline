// functions/lib/stages.js
//
// Stage catalog lookups + gate rule engine.
//
// Gate rules are stored in the stage_definitions table as JSON:
//   { "requires": [ { "check": "<name>", "severity": "soft"|"hard" } ] }
//
// Enforcement mode:
//   GATE_MODE = 'warn'  → all violations shown as warnings, transition allowed
//   GATE_MODE = 'enforce' → soft violations warn, hard violations block
//
// To switch to enforcing mode later, change GATE_MODE to 'enforce'.

import { all, one } from './db.js';

// ---- Configuration ------------------------------------------------
// Change this to 'enforce' when ready to block transitions on hard gates.
export const GATE_MODE = 'warn';

// ---- Stage catalog ------------------------------------------------

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

export async function stagesFor(db, transactionType) {
  const catalog = await loadStageCatalog(db);
  return catalog.get(transactionType) ?? [];
}

export async function stageDef(db, transactionType, stageKey) {
  const list = await stagesFor(db, transactionType);
  return list.find((s) => s.stage_key === stageKey) ?? null;
}

// ---- Gate check implementations -----------------------------------
//
// Each check receives a context object:
//   { db, opportunity, account, contacts, quotes, costBuilds }
// and returns { passed: boolean, message: string }

const CHECKS = {
  async has_account_and_contact(ctx) {
    const hasAccount = !!ctx.opportunity.account_id;
    const hasContact = ctx.contacts.length > 0;
    if (hasAccount && hasContact) return { passed: true };
    const missing = [];
    if (!hasAccount) missing.push('account');
    if (!hasContact) missing.push('contact');
    return { passed: false, message: `Missing ${missing.join(' and ')}` };
  },

  async has_cost_build(ctx) {
    if (ctx.costBuilds.length > 0) return { passed: true };
    return { passed: false, message: 'No price build exists on any quote' };
  },

  async has_cost_build_locked(ctx) {
    const locked = ctx.costBuilds.some(cb => cb.status === 'locked');
    if (locked) return { passed: true };
    if (ctx.costBuilds.length === 0) return { passed: false, message: 'No price build exists' };
    return { passed: false, message: 'No price build is locked' };
  },

  async has_bant_fields(ctx) {
    const o = ctx.opportunity;
    const missing = [];
    if (!o.bant_budget) missing.push('budget');
    if (!o.bant_authority) missing.push('authority');
    if (!o.bant_need) missing.push('need');
    if (!o.bant_timeline) missing.push('timeline');
    if (missing.length === 0) return { passed: true };
    return { passed: false, message: `BANT missing: ${missing.join(', ')}` };
  },

  async has_valid_until_set(ctx) {
    const hasIt = ctx.quotes.some(q =>
      q.valid_until && (q.status === 'submitted' || q.status === 'draft' || q.status === 'approved_internal')
    );
    if (hasIt) return { passed: true };
    if (ctx.quotes.length === 0) return { passed: false, message: 'No quote exists' };
    return { passed: false, message: 'No quote has a valid-until date set' };
  },

  async has_delivery_terms_set(ctx) {
    const hasIt = ctx.quotes.some(q => q.delivery_terms);
    if (hasIt) return { passed: true };
    if (ctx.quotes.length === 0) return { passed: false, message: 'No quote exists' };
    return { passed: false, message: 'No quote has delivery terms set' };
  },

  async has_payment_terms_set(ctx) {
    const hasIt = ctx.quotes.some(q => q.payment_terms);
    if (hasIt) return { passed: true };
    if (ctx.quotes.length === 0) return { passed: false, message: 'No quote exists' };
    return { passed: false, message: 'No quote has payment terms set' };
  },

  async has_governance_revisions_snapshotted(ctx) {
    const hasIt = ctx.quotes.some(q => q.tc_revision);
    if (hasIt) return { passed: true };
    if (ctx.quotes.length === 0) return { passed: false, message: 'No quote exists' };
    return { passed: false, message: 'No quote has governance revisions snapshotted (submit the quote first)' };
  },

  async has_customer_po(ctx) {
    // Check if any document of kind 'po' is attached
    const po = await one(ctx.db,
      `SELECT id FROM documents WHERE opportunity_id = ? AND kind = 'po' LIMIT 1`,
      [ctx.opportunity.id]);
    if (po) return { passed: true };
    return { passed: false, message: 'No customer PO document uploaded' };
  },

  async has_oc_data(ctx) {
    // For now, check if a quote has been accepted
    const accepted = ctx.quotes.some(q => q.status === 'accepted');
    if (accepted) return { passed: true };
    return { passed: false, message: 'No quote has been accepted (OC not ready)' };
  },
};

// ---- Gate evaluation ----------------------------------------------

/**
 * Load the context needed for gate checks.
 */
export async function loadGateContext(db, opportunity) {
  const [contacts, quotes, costBuilds] = await Promise.all([
    opportunity.account_id
      ? all(db, 'SELECT id FROM contacts WHERE account_id = ?', [opportunity.account_id])
      : [],
    all(db,
      `SELECT id, status, valid_until, delivery_terms, payment_terms, tc_revision
         FROM quotes WHERE opportunity_id = ?`,
      [opportunity.id]),
    all(db,
      `SELECT cb.id, cb.status
         FROM cost_builds cb
         JOIN quote_lines ql ON ql.id = cb.quote_line_id
         JOIN quotes q ON q.id = ql.quote_id
        WHERE q.opportunity_id = ?`,
      [opportunity.id]),
  ]);

  return { db, opportunity, contacts, quotes, costBuilds };
}

/**
 * Evaluate gate rules for a target stage.
 *
 * Returns { allowed, violations, warnings }.
 * - In 'warn' mode: allowed is always true, all violations go to warnings.
 * - In 'enforce' mode: hard violations set allowed=false, soft go to warnings.
 */
export async function evaluateGate(db, transactionType, targetStageKey, gateCtx) {
  const def = await stageDef(db, transactionType, targetStageKey);
  if (!def || !def.gate_rules?.requires) {
    return { allowed: true, violations: [], warnings: [] };
  }

  const violations = [];
  const warnings = [];

  for (const rule of def.gate_rules.requires) {
    const checkFn = CHECKS[rule.check];
    if (!checkFn) continue;

    const result = await checkFn(gateCtx);
    if (result.passed) continue;

    const entry = {
      check: rule.check,
      severity: rule.severity ?? 'soft',
      message: result.message || `Gate check failed: ${rule.check}`,
    };

    violations.push(entry);

    if (GATE_MODE === 'warn') {
      // Warn-only mode: everything is a warning, nothing blocks
      warnings.push(entry);
    } else {
      // Enforce mode: soft → warning, hard → blocker
      if (entry.severity === 'soft') {
        warnings.push(entry);
      }
      // hard violations stay in violations[] and will block
    }
  }

  const hardFail = GATE_MODE === 'enforce' && violations.some(v => v.severity === 'hard');

  return {
    allowed: !hardFail,
    violations,
    warnings,
  };
}
