// functions/lib/pricing.js
//
// Cost-build total / margin / price math. Supports the three modes
// from plan §2.3:
//   - bottom_up: lines → total_cost (auto) → target_price via margin
//   - top_down:  target_price → back-solve implied margin
//   - mixed:     anything in between (manual total, partial lines, etc.)
//
// Rules (implemented in M4):
//   * total_cost_source='lines'  → total_cost = sum(cost_lines.extended_cost)
//   * total_cost_source='manual' → total_cost is user-entered, lines informational
//   * target_price editable directly; recompute target_margin_pct as hint
//   * target_margin_pct editable directly; recompute target_price as hint
//   * extended_cost = quantity * unit_cost (server-computed on line write)

/**
 * Recompute extended_cost for a line.
 */
export function extendedCost(quantity, unitCost) {
  const q = Number(quantity) || 0;
  const c = Number(unitCost) || 0;
  return round2(q * c);
}

/**
 * Sum the extended_cost field across an array of cost_lines.
 */
export function sumLinesExtended(lines) {
  return round2((lines ?? []).reduce((acc, l) => acc + (Number(l.extended_cost) || 0), 0));
}

/**
 * Given total_cost and target_price, compute margin pct.
 * Returns null if target_price is zero/null.
 */
export function marginFromPrice(totalCost, targetPrice) {
  const c = Number(totalCost) || 0;
  const p = Number(targetPrice);
  if (!p || p === 0) return null;
  return round2(((p - c) / p) * 100);
}

/**
 * Given total_cost and target_margin_pct, compute target price.
 * Returns null if the margin is 100% (division by zero).
 */
export function priceFromMargin(totalCost, targetMarginPct) {
  const c = Number(totalCost) || 0;
  const m = Number(targetMarginPct);
  if (m === null || m === undefined || Number.isNaN(m)) return null;
  if (m >= 100) return null;
  return round2(c / (1 - m / 100));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
