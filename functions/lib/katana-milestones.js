// functions/lib/katana-milestones.js
//
// Loads / validates / saves the katana_milestone_map JSON blob on
// site_prefs (migration 0072). Mirrors lib/eps-schedule.js — same
// pattern, different concern.
//
// The map pairs each EPS milestone with the Katana variant_id it
// pushes against, in display order. The /settings/katana-milestones
// admin page edits it; the "Push to Katana" route on the quote
// detail page reads it.
//
// Shape:
//   {
//     "milestones": [
//       { "percent": 10, "label": "Order Confirmation",
//         "katana_variant_id": 40099667, "katana_sku": "MS-1ST-10%-OC" },
//       ...
//     ]
//   }
//
// Order of the array IS the milestone order (1st, 2nd, …). The Push
// flow uses position-as-identity. Percentages must sum to 100.

import { one, batch, stmt } from './db.js';
import { auditStmt } from './audit.js';

/**
 * Read the saved map. Returns null when nothing is configured yet —
 * the admin needs to visit /settings/katana-milestones first.
 */
export async function loadMilestoneMap(env) {
  const row = await one(env.DB,
    `SELECT katana_milestone_map FROM site_prefs WHERE id = 1`);
  const raw = row?.katana_milestone_map;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    validateMilestoneMap(parsed);
    return parsed;
  } catch (_) {
    return null;
  }
}

/**
 * Throws on a malformed map. Used on the admin save path and as a
 * belt-and-suspenders guard inside loadMilestoneMap.
 */
export function validateMilestoneMap(map) {
  if (!map || typeof map !== 'object') throw new Error('map must be an object');
  const ms = map.milestones;
  if (!Array.isArray(ms) || ms.length === 0) {
    throw new Error('milestones must be a non-empty array');
  }
  if (ms.length > 20) throw new Error('too many milestones (max 20)');

  let sum = 0;
  ms.forEach((m, i) => {
    if (!m || typeof m !== 'object') throw new Error(`milestone ${i + 1}: not an object`);
    const p = Number(m.percent);
    if (!Number.isFinite(p) || p <= 0 || p > 100) {
      throw new Error(`milestone ${i + 1}: percent must be a positive number <= 100`);
    }
    sum += p;
    if (typeof m.label !== 'string' || m.label.trim() === '') {
      throw new Error(`milestone ${i + 1}: label must be a non-empty string`);
    }
    const v = parseInt(m.katana_variant_id, 10);
    if (!Number.isFinite(v) || v <= 0) {
      throw new Error(`milestone ${i + 1}: katana_variant_id must be a positive integer`);
    }
  });
  if (Math.abs(sum - 100) > 0.01) {
    throw new Error(`milestone percentages must sum to 100 (got ${sum})`);
  }
}

/**
 * Validate + upsert + audit. Returns the normalized stored map.
 */
export async function saveMilestoneMap(env, map, user) {
  validateMilestoneMap(map);
  const normalized = {
    milestones: map.milestones.map((m) => ({
      percent: Number(m.percent),
      label: String(m.label).trim(),
      katana_variant_id: parseInt(m.katana_variant_id, 10),
      katana_sku: String(m.katana_sku || '').trim(),
    })),
  };
  const json = JSON.stringify(normalized);

  const existing = await one(env.DB,
    `SELECT katana_milestone_map FROM site_prefs WHERE id = 1`);
  const previous = existing?.katana_milestone_map ?? '';

  await batch(env.DB, [
    stmt(env.DB,
      `UPDATE site_prefs
          SET katana_milestone_map = ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              updated_by = ?
        WHERE id = 1`,
      [json, user?.id ?? null]),
    auditStmt(env.DB, {
      entityType: 'site_prefs',
      entityId: '1',
      eventType: 'updated',
      user,
      summary: `Updated Katana milestone map (${normalized.milestones.length} milestones)`,
      changes: { katana_milestone_map: { from: previous, to: json } },
    }),
  ]);
  return normalized;
}

/**
 * Parse a milestone-product SKU into its constituent fields. Returns
 * null when the SKU doesn't match Adam's pattern. Used by the admin
 * page's "Auto-discover" button to pre-fill the map from Katana's
 * existing products.
 *
 * Example SKUs (from Adam's tenant):
 *   "MS-1ST-10%-OC"          -> { ordinal: 1, percent: 10, suffix: "OC" }
 *   "MS-2ND-15%-OLL&SCH"     -> { ordinal: 2, percent: 15, suffix: "OLL&SCH" }
 *   "MS-3RD-30%-PURCH"       -> { ordinal: 3, percent: 30, suffix: "PURCH" }
 */
export function parseMilestoneSku(sku) {
  if (typeof sku !== 'string') return null;
  const m = /^MS-(\d+)(?:ST|ND|RD|TH)-([\d.]+)%-(.*)$/i.exec(sku.trim());
  if (!m) return null;
  const ordinal = parseInt(m[1], 10);
  const percent = parseFloat(m[2]);
  const suffix  = m[3].trim();
  if (!Number.isFinite(ordinal) || ordinal <= 0) return null;
  if (!Number.isFinite(percent) || percent <= 0) return null;
  return { ordinal, percent, suffix };
}

/**
 * Take a Katana product list (from /products), filter to milestone
 * products, parse each SKU, sort by ordinal, return the suggested
 * milestone-map rows. Used by the admin page's "Auto-discover from
 * Katana" button — gives the user a one-click pre-fill they can
 * tweak before saving.
 */
export function autoDiscoverFromProducts(products) {
  const out = [];
  for (const p of (products || [])) {
    const sku = p?.variants?.[0]?.sku;
    const variantId = p?.variants?.[0]?.id;
    if (!sku || !variantId) continue;
    const parsed = parseMilestoneSku(sku);
    if (!parsed) continue;
    // Prefer the product's name as the label since it's already
    // capitalized and trimmed (e.g. "1ST MILESTONE 10% ORDER
    // CONFIRMATION"). Strip the leading "Nth MILESTONE PCT% " prefix
    // for a tighter label.
    let label = String(p.name || '').trim();
    label = label.replace(/^\d+(?:ST|ND|RD|TH)\s+MILESTONE\s+[\d.]+%\s+/i, '').trim();
    if (!label) label = parsed.suffix;
    out.push({
      ordinal: parsed.ordinal,
      percent: parsed.percent,
      label,
      katana_variant_id: variantId,
      katana_sku: sku,
    });
  }
  out.sort((a, b) => a.ordinal - b.ordinal);
  // Drop the synthetic ordinal field — caller wants the storable shape.
  return out.map((m) => ({
    percent: m.percent,
    label: m.label,
    katana_variant_id: m.katana_variant_id,
    katana_sku: m.katana_sku,
  }));
}
