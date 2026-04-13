// functions/lib/quote-cost-ref.js
//
// Parse and resolve the cost_ref select value from the quote line form.
// The select sends "dm:<id>" or "labor:<id>" or "" (no reference).
// Returns { cost_ref_type, cost_ref_id, cost_ref_amount } ready to
// persist on the quote_lines row.

import { one, all } from './db.js';
import { loadPricingSettings } from './pricing.js';

export async function resolveCostRef(db, costRefValue) {
  if (!costRefValue || !costRefValue.includes(':')) {
    return { cost_ref_type: null, cost_ref_id: null, cost_ref_amount: null };
  }

  const [refType, refId] = costRefValue.split(':', 2);

  if (refType === 'dm') {
    const dm = await one(db, 'SELECT cost FROM dm_items WHERE id = ?', [refId]);
    return {
      cost_ref_type: 'dm',
      cost_ref_id: refId,
      cost_ref_amount: dm ? Number(dm.cost) : null,
    };
  }

  if (refType === 'labor') {
    const entries = await all(
      db,
      'SELECT hours, rate FROM labor_item_entries WHERE labor_item_id = ?',
      [refId]
    );
    const settings = await loadPricingSettings(db);
    const defaultRate = Number(settings.defaultLaborRate) || 0;
    const totalCost = entries.reduce((acc, e) => {
      const rate = e.rate != null ? Number(e.rate) : defaultRate;
      return acc + (Number(e.hours) || 0) * rate;
    }, 0);
    return {
      cost_ref_type: 'labor',
      cost_ref_id: refId,
      cost_ref_amount: totalCost,
    };
  }

  return { cost_ref_type: null, cost_ref_id: null, cost_ref_amount: null };
}
