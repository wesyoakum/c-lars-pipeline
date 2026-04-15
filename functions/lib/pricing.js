// functions/lib/pricing.js
//
// Server-side port of the C-LARS calculators pricing engine
// (calculatePricing() from ../calculators/index.html).
//
// Model (migration 0005):
//   Fixed 4-category cost structure with target percentages:
//     DM    target 30%
//     DL    target 25%
//     IMOH  target 16%
//     Other target 0.5%
//     --------------------
//     Total cost 71.5%  → 28.5% target margin
//
//   Target Price = Total Cost / 0.715
//   Margin       = Quote Price - Total Cost
//   Margin pct   = Margin / Quote Price
//   "Good" if marginPct > 0.284 (28.4%)
//
//   Any of DM/DL/IMOH/Other can be user-set; blanks auto-fill from the
//   effective quote × target %. Quote itself can auto-fill from DM (and
//   DL) when user hasn't typed one.
//
//   DM can alternatively be linked to the dm_items library (sum of
//   selected items). DL can alternatively be linked to the labor_items
//   library plus a per-cost-build "Current Project" workcenter breakdown.
//
// All functions here are pure — no HTML/DOM, no D1 side effects except in
// the loaders at the bottom (which are thin wrappers over one/all).

import { one, all, stmt } from './db.js';

// =====================================================================
// 1. Pricing settings loader
// =====================================================================

const DEFAULT_SETTINGS = {
  targetPct: { dm: 0.30, dl: 0.25, imoh: 0.16, other: 0.005 },
  defaultLaborRate: 23,
  marginThresholdGood: 0.284,
  workcenters: ['Fab', 'Paint', 'Mechanical', 'Electrical', 'Hydraulic', 'Testing', 'Engineering'],
};

/**
 * Load pricing_settings (key/value) from D1 into a typed object.
 * Falls back to DEFAULT_SETTINGS for any missing keys so callers never
 * crash on a partially-seeded table.
 */
export async function loadPricingSettings(db) {
  const rows = await all(db, 'SELECT key, value FROM pricing_settings');
  const map = {};
  for (const r of rows) map[r.key] = r.value;

  const num = (k, d) => {
    const v = map[k];
    if (v === undefined || v === null || v === '') return d;
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };

  let workcenters = DEFAULT_SETTINGS.workcenters;
  if (map.workcenters) {
    try {
      const parsed = JSON.parse(map.workcenters);
      if (Array.isArray(parsed) && parsed.length > 0) workcenters = parsed;
    } catch (_) { /* keep default */ }
  }

  return {
    targetPct: {
      dm:    num('target_pct_dm',    DEFAULT_SETTINGS.targetPct.dm),
      dl:    num('target_pct_dl',    DEFAULT_SETTINGS.targetPct.dl),
      imoh:  num('target_pct_imoh',  DEFAULT_SETTINGS.targetPct.imoh),
      other: num('target_pct_other', DEFAULT_SETTINGS.targetPct.other),
    },
    defaultLaborRate:    num('default_labor_rate',    DEFAULT_SETTINGS.defaultLaborRate),
    marginThresholdGood: num('margin_threshold_good', DEFAULT_SETTINGS.marginThresholdGood),
    workcenters,
  };
}

export { DEFAULT_SETTINGS };

// =====================================================================
// 2. Labor cost helpers
// =====================================================================

/**
 * Cost of a single (hours, rate) workcenter entry. null/missing rate
 * falls back to the default labor rate from settings.
 */
export function workcenterEntryCost(hours, rate, settings) {
  const h = Number(hours) || 0;
  if (h === 0) return 0;
  const defaultRate = settings?.defaultLaborRate ?? DEFAULT_SETTINGS.defaultLaborRate;
  const r = (rate === null || rate === undefined || rate === '')
    ? defaultRate
    : (Number(rate) || defaultRate);
  return h * r;
}

/**
 * Sum an array of workcenter entries ({workcenter, hours, rate}) into a
 * total cost.
 */
export function sumWorkcenterEntries(entries, settings) {
  if (!Array.isArray(entries)) return 0;
  let total = 0;
  for (const e of entries) {
    total += workcenterEntryCost(e?.hours, e?.rate, settings);
  }
  return total;
}

/**
 * Compute the cost of a single labor library item given its workcenter
 * entries. Same shape as sumWorkcenterEntries.
 */
export function computeLaborItemCost(entries, settings) {
  return sumWorkcenterEntries(entries, settings);
}

// =====================================================================
// 3. Core pricing calculator (pure port of calculatePricing)
// =====================================================================

/**
 * Normalize a user input to number-or-null. null means "user has not
 * typed anything for this field" (it will be auto-filled).
 *   null/undefined/''  → null
 *   number/numeric str → Number
 */
function normNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '') return null;
  const n = Number(s.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * computePricing(inputs, settings) — the heart of the engine.
 *
 * inputs shape:
 *   {
 *     dmUser, dlUser, imohUser, otherUser, quoteUser,   // nullable user values
 *     dmLibraryTotal,                                   // null if not linked
 *     laborCalcTotal,                                   // null if not linked
 *   }
 *
 * Any user value that is null is treated as "not typed" and will be
 * auto-filled from the effective quote × target %.
 *
 * dmLibraryTotal and laborCalcTotal override dmUser / dlUser when set
 * (i.e. library/labor-calc linkage wins over manual entry).
 *
 * Returns:
 *   {
 *     effective: { dm, dl, imoh, other, quote, totalCost, targetPrice },
 *     auto:      { dm, dl, imoh, other, quote },   // what was auto-filled
 *     notes:     { dm, dl, imoh, other, quote },   // tooltip strings
 *     margin:    { amount, pct, status, threshold },
 *     references:{
 *       fromQuote: { dm, dl, imoh, other },
 *       fromDm:    { price, dl, imoh, other },
 *       fromDmDl:  { price, imoh, other },
 *     },
 *     targetPct,   // echoed for display
 *     linked:    { dm: bool, labor: bool },
 *   }
 *
 * NOTE: The `fromDm.other` reference reproduces a quirk from the
 * calculators app where Other is divided by pDl instead of pDm. It's
 * preserved here for parity with the existing tool; if the user wants
 * to "fix" it later it's a one-line change.
 */
export function computePricing(inputs, settings) {
  const s = settings || DEFAULT_SETTINGS;
  const pDm    = s.targetPct.dm;
  const pDl    = s.targetPct.dl;
  const pImoh  = s.targetPct.imoh;
  const pOther = s.targetPct.other;
  const pDmDl  = pDm + pDl;
  const totalTargetPct = pDm + pDl + pImoh + pOther;

  const dmLink    = normNum(inputs?.dmLibraryTotal);
  const laborLink = normNum(inputs?.laborCalcTotal);
  const useDmLib    = dmLink    !== null;
  const useLaborLib = laborLink !== null;

  // Effective user-side values. Library/labor-calc linkage trumps manual
  // user entry; otherwise fall back to what the user typed.
  const dmUser    = useDmLib    ? dmLink    : normNum(inputs?.dmUser);
  const dlUser    = useLaborLib ? laborLink : normNum(inputs?.dlUser);
  const imohUser  = normNum(inputs?.imohUser);
  const otherUser = normNum(inputs?.otherUser);
  const quoteUser = normNum(inputs?.quoteUser);

  // --- Auto-fill pass ---
  let dmAuto = null, dlAuto = null, imohAuto = null, otherAuto = null, quoteAuto = null;

  // Quote auto-fill from DM (and DL) when quote is blank.
  // Zero is treated as an explicit user value, not an auto-fill source.
  if (quoteUser === null && dmUser !== null && dmUser > 0) {
    if (dlUser !== null && dlUser > 0) {
      quoteAuto = (dmUser + dlUser) / pDmDl;
    } else {
      quoteAuto = dmUser / pDm;
    }
  }

  // Effective quote drives all remaining auto-fills.
  const effQuote = quoteUser !== null ? quoteUser : quoteAuto;

  if (effQuote !== null && effQuote > 0 && dmUser === null) {
    dmAuto = effQuote * pDm;
  }
  if (effQuote !== null && effQuote > 0 && dlUser === null && !useLaborLib) {
    dlAuto = effQuote * pDl;
  }
  if (effQuote !== null && effQuote > 0 && imohUser === null) {
    imohAuto = effQuote * pImoh;
  }
  if (effQuote !== null && effQuote > 0 && otherUser === null) {
    otherAuto = effQuote * pOther;
  }

  // Effective (final) values per category.
  const dm    = dmUser    !== null ? dmUser    : dmAuto;
  const dl    = dlUser    !== null ? dlUser    : dlAuto;
  const imoh  = imohUser  !== null ? imohUser  : imohAuto;
  const other = otherUser !== null ? otherUser : otherAuto;
  const quote = quoteUser !== null ? quoteUser : quoteAuto;

  // Total cost: null when literally nothing is known. Otherwise treat
  // unknown categories as 0 (same as calculator).
  const anyCostKnown = (dm !== null) || (dl !== null) || (imoh !== null) || (other !== null);
  const totalCost = anyCostKnown
    ? ((dm || 0) + (dl || 0) + (imoh || 0) + (other || 0))
    : null;

  const targetPrice = (totalCost !== null && totalCost > 0)
    ? totalCost / totalTargetPct
    : null;

  // --- Margin ---
  let margin = { amount: null, pct: null, status: null, threshold: s.marginThresholdGood };
  if (quote !== null && totalCost !== null && quote > 0) {
    const amt = quote - totalCost;
    const pct = amt / quote;
    margin = {
      amount: amt,
      pct,
      status: pct > s.marginThresholdGood ? 'good' : 'low',
      threshold: s.marginThresholdGood,
    };
  }

  // --- Reference estimates (shown as helper panels in the UI) ---
  const fromQuote = {
    dm:    quote !== null ? quote * pDm    : null,
    dl:    quote !== null ? quote * pDl    : null,
    imoh:  quote !== null ? quote * pImoh  : null,
    other: quote !== null ? quote * pOther : null,
  };

  const fromDm = {
    price: dm !== null ? dm / pDm                 : null,
    dl:    dm !== null ? (dm * pDl)    / pDm      : null,
    imoh:  dm !== null ? (dm * pImoh)  / pDm      : null,
    // NB: calculator divides Other by pDl (not pDm). Preserved for parity.
    other: dm !== null ? (dm * pOther) / pDl      : null,
  };

  const dmDlPrice = (dm !== null && dl !== null) ? (dm + dl) / pDmDl : null;
  const fromDmDl = {
    price: dmDlPrice,
    imoh:  dmDlPrice !== null ? dmDlPrice * pImoh  : null,
    other: dmDlPrice !== null ? dmDlPrice * pOther : null,
  };

  // --- Note/label helpers (parity with calculator UI phrasing) ---
  let estSrc = '';
  if (quoteUser !== null) estSrc = 'Estimated from Quote Price';
  else if (dmUser !== null && dlUser !== null) estSrc = 'Estimated from DM + DL';
  else if (dmUser !== null) estSrc = 'Estimated from DM';

  const notes = {
    dm:    useDmLib
             ? 'Linked to Direct Material library'
             : (dmAuto !== null ? 'Estimated from Quote Price' : ''),
    dl:    useLaborLib
             ? 'Linked to Labor Cost calculator'
             : (dlAuto !== null ? estSrc : ''),
    imoh:  imohAuto  !== null ? estSrc : '',
    other: otherAuto !== null ? estSrc : '',
    quote: quoteAuto !== null
             ? ((dlUser !== null) ? 'Estimated from DM + DL' : 'Estimated from DM')
             : '',
  };

  return {
    effective: { dm, dl, imoh, other, quote, totalCost, targetPrice },
    auto:      { dm: dmAuto, dl: dlAuto, imoh: imohAuto, other: otherAuto, quote: quoteAuto },
    notes,
    margin,
    references: { fromQuote, fromDm, fromDmDl },
    targetPct: { dm: pDm, dl: pDl, imoh: pImoh, other: pOther, total: totalTargetPct },
    linked: { dm: useDmLib, labor: useLaborLib },
  };
}

// =====================================================================
// 4. Display formatters
// =====================================================================

/**
 * Format a number as USD. Null/undefined → '-'. Matches the calculator's
 * whole-dollar display ($12,345).
 */
export function fmtDollar(n, { showNull = '-' } = {}) {
  if (n === null || n === undefined || Number.isNaN(n)) return showNull;
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Format a ratio 0..1 as a percentage string. Default 1 decimal.
 */
export function fmtPct(n, decimals = 1, { showNull = '-' } = {}) {
  if (n === null || n === undefined || Number.isNaN(n)) return showNull;
  return (Number(n) * 100).toFixed(decimals) + '%';
}

/**
 * Render a known-or-dash dollar cell.
 */
export function fmtKnown(v) {
  return v !== null && v !== undefined ? fmtDollar(v) : '-';
}

// =====================================================================
// 5. Cost-build bundle loader (DB → pure inputs for computePricing)
// =====================================================================

/**
 * Load everything needed to compute a price build's pricing in one go:
 *   - the cost_builds row
 *   - cost_build_labor (this build's workcenter hours/rate)
 *   - cost_build_dm_selections + joined dm_items (descriptions + cost)
 *   - cost_build_labor_selections + joined labor_items + labor_item_entries
 *
 * Caller can then call computeFromBundle(bundle, settings) to run the
 * pricing engine against this bundle.
 */
export async function loadCostBuildBundle(db, costBuildId) {
  const build = await one(
    db,
    'SELECT * FROM cost_builds WHERE id = ?',
    [costBuildId]
  );
  if (!build) return null;

  const currentLabor = await all(
    db,
    'SELECT workcenter, hours, rate FROM cost_build_labor WHERE cost_build_id = ?',
    [costBuildId]
  );

  const dmSelections = await all(
    db,
    `SELECT dm.id, dm.description, dm.cost
       FROM cost_build_dm_selections sel
       JOIN dm_items dm ON dm.id = sel.dm_item_id
      WHERE sel.cost_build_id = ?
      ORDER BY dm.description`,
    [costBuildId]
  );

  const laborSelectionRows = await all(
    db,
    `SELECT li.id, li.description
       FROM cost_build_labor_selections sel
       JOIN labor_items li ON li.id = sel.labor_item_id
      WHERE sel.cost_build_id = ?
      ORDER BY li.description`,
    [costBuildId]
  );

  // Hydrate each selected labor item with its workcenter entries.
  const laborSelections = [];
  for (const li of laborSelectionRows) {
    const entries = await all(
      db,
      'SELECT workcenter, hours, rate FROM labor_item_entries WHERE labor_item_id = ?',
      [li.id]
    );
    laborSelections.push({ ...li, entries });
  }

  return { build, currentLabor, dmSelections, laborSelections };
}

/**
 * Run the pricing engine against a bundle (from loadCostBuildBundle).
 * Returns { pricing, totals } where totals exposes the intermediate
 * library/labor sums so the UI can show them independently.
 */
export function computeFromBundle(bundle, settings) {
  const s = settings || DEFAULT_SETTINGS;
  const b = bundle.build;

  // DM library total (null if linkage is off)
  const dmLibTotal = b.use_dm_library
    ? (bundle.dmSelections || []).reduce((acc, it) => acc + (Number(it.cost) || 0), 0)
    : null;

  // Labor: current-project workcenter entries
  const currentLaborTotal = sumWorkcenterEntries(bundle.currentLabor || [], s);

  // Labor library selections total
  const laborLibTotal = (bundle.laborSelections || [])
    .reduce((acc, li) => acc + sumWorkcenterEntries(li.entries || [], s), 0);

  // DL linkage total when use_labor_library is on:
  //   current project hours + labor library selections (matches calculator
  //   behavior of summing both into laborTotal)
  const laborCalcTotal = b.use_labor_library
    ? (currentLaborTotal + laborLibTotal)
    : null;

  const pricing = computePricing(
    {
      dmUser:    b.dm_user_cost,
      dlUser:    b.dl_user_cost,
      imohUser:  b.imoh_user_cost,
      otherUser: b.other_user_cost,
      quoteUser: b.quote_price_user,
      dmLibraryTotal: dmLibTotal,
      laborCalcTotal,
    },
    s
  );

  return {
    pricing,
    totals: {
      dmLibTotal,
      currentLaborTotal,
      laborLibTotal,
      laborCalcTotal,
    },
  };
}

// =====================================================================
// 6. Discount helpers (header-level, line-level, build-level)
// =====================================================================
//
// Three tables (quotes, quote_lines, cost_builds) all share the same four
// columns: discount_amount, discount_pct, discount_description,
// discount_is_phantom — so these helpers are scope-agnostic.
//
// Semantics:
//   - discount_amount wins over discount_pct when both are set.
//   - A phantom discount (`isPhantom` truthy) never reduces stored totals.
//     The unit_price (or subtotal) is already set to the real revenue
//     figure; a phantom discount only matters at render time, where the
//     PDF shows an inflated "list price" and a matching discount line that
//     lands back at the stored total. See the PDF generator for the
//     render-time markup.
//   - A real discount is subtracted from the scope value before tax.
//
// All inputs are null-tolerant so callers can pass raw D1 row fields.

/**
 * Compute the dollar value of a REAL (non-phantom) discount against a
 * scope amount. Returns 0 when the discount is phantom, missing, or not
 * applicable (negative or > scope).
 *
 *   computeDiscountApplied({amount: 500}, 2000)       → 500
 *   computeDiscountApplied({pct: 10}, 2000)           → 200
 *   computeDiscountApplied({amount: 5, isPhantom:1}, 2000) → 0
 *   computeDiscountApplied({}, 2000)                  → 0
 *   computeDiscountApplied({pct: 10}, 0)              → 0
 */
export function computeDiscountApplied(discount, scopeValue) {
  if (!discount) return 0;
  if (discount.isPhantom) return 0;
  const scope = Number(scopeValue) || 0;
  if (scope <= 0) return 0;

  const amt = normNum(discount.amount);
  if (amt !== null && amt > 0) {
    return Math.min(amt, scope);
  }
  const pct = normNum(discount.pct);
  if (pct !== null && pct > 0) {
    const ratio = Math.min(pct, 100) / 100;
    return scope * ratio;
  }
  return 0;
}

/**
 * Build a normalized discount object from a D1 row. Accepts either the
 * raw column names (discount_amount, discount_pct, discount_is_phantom)
 * or the short form (amount, pct, isPhantom). Returns null if the row
 * has no discount fields at all (so callers can cheaply early-out).
 */
export function readDiscountFromRow(row) {
  if (!row) return null;
  const amount = row.discount_amount ?? row.amount ?? null;
  const pct = row.discount_pct ?? row.pct ?? null;
  const description = row.discount_description ?? row.description ?? null;
  const isPhantom = !!(row.discount_is_phantom ?? row.isPhantom ?? 0);
  if (amount == null && pct == null && !description && !isPhantom) return null;
  return { amount, pct, description, isPhantom };
}

/**
 * Apply a quote header discount to a subtotal, returning the post-discount
 * subtotal (tax is added on top of this by the caller).
 *
 *   applyHeaderDiscount(row, subtotal) → { subtotalAfter, discountApplied }
 */
export function applyHeaderDiscount(quoteRow, subtotal) {
  const d = readDiscountFromRow(quoteRow);
  const applied = computeDiscountApplied(d, subtotal);
  return {
    subtotalAfter: (Number(subtotal) || 0) - applied,
    discountApplied: applied,
    isPhantom: !!(d && d.isPhantom),
  };
}

// =====================================================================
// 7. Quote totals recompute (subtotal, total, with discount)
// =====================================================================
//
// All line-mutation sites (add/edit/delete) and the tax-changed path in
// the quote patch handler recompute the parent quote's subtotal_price
// and total_price. The formula is:
//
//   subtotal_price = SUM(extended_price of all lines)
//   total_price    = subtotal_price - header_discount_applied + tax_amount
//
// Where header_discount_applied is:
//   - 0 if discount_is_phantom = 1 (phantom discounts don't reduce stored
//     totals; they're a render-time markup only)
//   - min(discount_amount, subtotal) if discount_amount is set
//   - subtotal * (min(discount_pct, 100) / 100) if discount_pct is set
//   - 0 otherwise
//
// This SQL uses SQLite's multi-arg min() which is scalar (not aggregate)
// when given 2+ arguments. The four correlated subqueries all resolve to
// the same value (the new subtotal) — SQLite will evaluate them each
// time but the overhead is negligible for the line counts we see on
// real quotes (<< 100).

/**
 * Return a batch-friendly stmt that recomputes subtotal_price and
 * total_price for the given quote, taking any header discount into
 * account. Callers push this into their existing batch alongside the
 * INSERT/UPDATE/DELETE of the line that triggered the recompute.
 */
export function quoteTotalsRecomputeStmt(db, quoteId, ts) {
  return stmt(
    db,
    `UPDATE quotes
        SET subtotal_price = (SELECT COALESCE(SUM(extended_price), 0) FROM quote_lines WHERE quote_id = ?),
            total_price    =
              (SELECT COALESCE(SUM(extended_price), 0) FROM quote_lines WHERE quote_id = ?)
              - CASE
                  WHEN COALESCE(discount_is_phantom, 0) = 1 THEN 0
                  WHEN discount_amount IS NOT NULL AND discount_amount > 0 THEN
                    MIN(
                      discount_amount,
                      (SELECT COALESCE(SUM(extended_price), 0) FROM quote_lines WHERE quote_id = ?)
                    )
                  WHEN discount_pct IS NOT NULL AND discount_pct > 0 THEN
                    (SELECT COALESCE(SUM(extended_price), 0) FROM quote_lines WHERE quote_id = ?)
                      * (MIN(discount_pct, 100.0) / 100.0)
                  ELSE 0
                END
              + COALESCE(tax_amount, 0),
            updated_at     = ?
      WHERE id = ?`,
    [quoteId, quoteId, quoteId, quoteId, ts, quoteId]
  );
}
