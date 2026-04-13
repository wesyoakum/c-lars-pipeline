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
  // --- Lead gates ---
  async has_title(ctx) {
    if (ctx.opportunity.title) return { passed: true };
    return { passed: false, message: 'Missing title' };
  },

  async has_account(ctx) {
    if (ctx.opportunity.account_id) return { passed: true };
    return { passed: false, message: 'Missing account' };
  },

  // --- RFQ Received gates ---
  async has_rfq_fields(ctx) {
    const o = ctx.opportunity;
    const missing = [];
    if (!o.transaction_type) missing.push('type');
    if (!o.primary_contact_id) missing.push('primary contact');
    if (!o.description) missing.push('description');
    if (!o.rfq_format) missing.push('RFQ format');
    if (!o.source) missing.push('source');
    if (o.estimated_value_usd == null) missing.push('estimated value');
    if (!o.rfq_received_date) missing.push('RFQ received date');
    if (!o.rfq_due_date) missing.push('RFQ due date');
    if (missing.length === 0) return { passed: true };
    return { passed: false, message: `Missing: ${missing.join(', ')}` };
  },

  // --- Awaiting Client Feedback ---
  async has_activity_note(ctx) {
    const activity = await one(ctx.db,
      `SELECT id FROM activities WHERE opportunity_id = ? LIMIT 1`,
      [ctx.opportunity.id]);
    if (activity) return { passed: true };
    return { passed: false, message: 'No activity or note logged on this opportunity' };
  },

  // --- Quote gates ---
  async has_quote_draft(ctx) {
    const has = ctx.quotes.some(q => q.status === 'draft' || q.status === 'revision_draft');
    if (has) return { passed: true };
    if (ctx.quotes.length === 0) return { passed: false, message: 'No quote exists' };
    return { passed: false, message: 'No quote in draft status' };
  },

  async has_quote_issued(ctx) {
    const has = ctx.quotes.some(q => q.status === 'issued');
    if (has) return { passed: true };
    if (ctx.quotes.length === 0) return { passed: false, message: 'No quote exists' };
    return { passed: false, message: 'No quote has been issued' };
  },

  async has_quote_revision_draft(ctx) {
    const has = ctx.quotes.some(q => q.status === 'revision_draft');
    if (has) return { passed: true };
    return { passed: false, message: 'No revision draft exists' };
  },

  async has_quote_revision_issued(ctx) {
    const has = ctx.quotes.some(q => q.status === 'revision_issued');
    if (has) return { passed: true };
    return { passed: false, message: 'No revision has been issued' };
  },

  // --- Closed Won gates ---
  async has_customer_po_number(ctx) {
    if (ctx.opportunity.customer_po_number) return { passed: true };
    return { passed: false, message: 'Missing customer PO number' };
  },

  async has_customer_po_document(ctx) {
    const po = await one(ctx.db,
      `SELECT id FROM documents WHERE opportunity_id = ? AND kind = 'po' LIMIT 1`,
      [ctx.opportunity.id]);
    if (po) return { passed: true };
    return { passed: false, message: 'No customer PO document uploaded' };
  },

  // --- Close reason ---
  async has_close_reason(ctx) {
    // This is checked specially in the stage transition handler
    // via the override_reason field. Always passes here — the handler enforces it.
    return { passed: true };
  },

  // --- Legacy checks (kept for compatibility) ---
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

  async has_valid_until_set(ctx) {
    const hasIt = ctx.quotes.some(q => q.valid_until);
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
    return { passed: false, message: 'No quote has been issued yet (governance snapshot missing)' };
  },

  async has_oc_data(ctx) {
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
