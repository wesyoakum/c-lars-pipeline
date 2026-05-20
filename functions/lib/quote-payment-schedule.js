// functions/lib/quote-payment-schedule.js
//
// Per-quote payment schedule — validation, rendering, and per-quote-
// type default management.
//
// Shape (migration 0074):
//   {
//     "rows": [
//       { "percent": 10, "weeks": 0, "label": "Due at order confirmation",
//         "katana_variant_id": 40099667, "katana_sku": "MS-1ST-10%-OC" },
//       ...
//     ]
//   }
//
// Used by:
//   * Quote detail page editor (read + save the JSON)
//   * /push-to-katana route (build per-line Katana sales orders using
//     the quote's schedule; fall back to the site-wide milestone map
//     when quotes.payment_schedule is NULL)
//   * (future) the doc-template renderer to populate payment_terms
//
// Per-type defaults live in quote_payment_schedule_defaults (migration
// 0075), one row per quote_type. Loaded by the editor's "Copy from
// type default" button and written by the admin "Set as default" button.

import { one, all, run } from './db.js';

/**
 * Parse the stored TEXT column. Returns the parsed schedule object,
 * or null if the column is empty / unparseable / fails validation.
 */
export function parseQuoteSchedule(raw) {
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    validateSchedule(parsed);
    return parsed;
  } catch (_) {
    return null;
  }
}

/**
 * Throws on a malformed schedule. Same shape as eps-schedule and
 * katana-milestones, just with the literal `weeks` field instead of
 * weeks_num / weeks_den.
 */
export function validateSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') throw new Error('schedule must be an object');
  const rows = schedule.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('schedule.rows must be a non-empty array');
  }
  if (rows.length > 20) throw new Error('too many milestone rows (max 20)');

  let sum = 0;
  rows.forEach((r, i) => {
    if (!r || typeof r !== 'object') throw new Error(`row ${i + 1}: not an object`);
    const p = Number(r.percent);
    if (!Number.isFinite(p) || p <= 0 || p > 100) {
      throw new Error(`row ${i + 1}: percent must be a positive number <= 100`);
    }
    sum += p;
    if (typeof r.label !== 'string' || r.label.trim() === '') {
      throw new Error(`row ${i + 1}: label must be a non-empty string`);
    }
    if (r.weeks != null && r.weeks !== '') {
      const w = Number(r.weeks);
      if (!Number.isFinite(w) || w < 0) {
        throw new Error(`row ${i + 1}: weeks must be a non-negative number or null`);
      }
    }
    if (r.katana_variant_id != null && r.katana_variant_id !== '') {
      const v = parseInt(r.katana_variant_id, 10);
      if (!Number.isFinite(v) || v <= 0) {
        throw new Error(`row ${i + 1}: katana_variant_id must be a positive integer or null`);
      }
    }
  });
  if (Math.abs(sum - 100) > 0.01) {
    throw new Error(`milestone percentages must sum to 100 (got ${sum})`);
  }
}

/**
 * Normalize a schedule for storage — coerce types, drop empty optional
 * fields, sort by ordinal position. The validate() call inside
 * guarantees the result is roundtrip-safe.
 */
export function normalizeSchedule(schedule) {
  validateSchedule(schedule);
  return {
    rows: schedule.rows.map((r) => {
      const out = {
        percent: Number(r.percent),
        label: String(r.label).trim(),
      };
      if (r.weeks != null && r.weeks !== '') {
        const w = Number(r.weeks);
        if (Number.isFinite(w) && w >= 0) out.weeks = w;
      }
      if (r.katana_variant_id != null && r.katana_variant_id !== '') {
        const v = parseInt(r.katana_variant_id, 10);
        if (Number.isFinite(v) && v > 0) out.katana_variant_id = v;
      }
      if (r.katana_sku) out.katana_sku = String(r.katana_sku).trim();
      return out;
    }),
  };
}

/**
 * Render the schedule to a multi-line string suitable for the
 * payment_terms textarea + customer-facing quote doc.
 *
 * Two label modes, picked per-row:
 *
 *  1. Token mode — label contains {percent} and/or {weeks} tokens.
 *     The tokens are substituted in place; nothing is prepended.
 *
 *       label: "Due {percent}% upon order confirmation"
 *       weeks: 0          -> "Due 10% upon order confirmation"
 *
 *       label: "{percent}% payable {weeks} weeks ARO"
 *       weeks: 8          -> "15% payable 8 weeks ARO"
 *
 *     This is the preferred form going forward — gives the user
 *     full control over the prose around the numbers.
 *
 *  2. Legacy mode — label has neither token. We prepend the
 *     percent ("10% <label>") and, if a weeks value is set and
 *     the label doesn't already mention "week", append "N week(s)
 *     after Order Confirmation." Preserves compat with labels
 *     imported from the old eps_schedule shape and from Katana
 *     auto-discover.
 */
export function scheduleToString(schedule) {
  const rows = Array.isArray(schedule?.rows) ? schedule.rows : [];
  return rows.map((r) => {
    const pct = formatPercent(r.percent);
    const w = r.weeks != null && r.weeks !== '' ? Number(r.weeks) : null;
    const wStr = Number.isFinite(w) ? String(w) : '';
    const label = String(r.label || '').trim();

    const hasPercentToken = label.includes('{percent}');
    const hasWeeksToken   = label.includes('{weeks}');

    if (hasPercentToken || hasWeeksToken) {
      // Token mode — substitute and emit exactly what the user wrote.
      return label.replace(/\{percent\}/g, pct).replace(/\{weeks\}/g, wStr);
    }

    // Legacy mode — prepend percent; optionally append weeks suffix.
    let out = `${pct}% ${label}`;
    if (Number.isFinite(w) && w > 0 && !/week/i.test(label)) {
      out += ` ${w} week${w === 1 ? '' : 's'} after Order Confirmation.`;
    }
    return out;
  }).join('\n');
}

function formatPercent(p) {
  const n = Number(p);
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2).replace(/\.?0+$/, '');
}

// =====================================================================
// Per-quote-type payment-schedule defaults (migration 0075).
// =====================================================================

/**
 * Read the default schedule for the given quote_type. Returns the
 * parsed object, or null if no default exists / it fails validation.
 */
export async function loadDefaultScheduleForType(env, quoteType) {
  if (!quoteType) return null;
  const row = await one(env.DB,
    `SELECT schedule_json FROM quote_payment_schedule_defaults WHERE quote_type = ?`,
    [quoteType]);
  if (!row?.schedule_json) return null;
  return parseQuoteSchedule(row.schedule_json);
}

/**
 * Read every per-type default. Returns an object keyed by quote_type
 * with each value being the parsed schedule (or null if invalid).
 */
export async function loadAllDefaultSchedules(env) {
  const rows = await all(env.DB,
    `SELECT quote_type, schedule_json, updated_at, updated_by
       FROM quote_payment_schedule_defaults`);
  const out = {};
  for (const r of rows) {
    out[r.quote_type] = {
      schedule: parseQuoteSchedule(r.schedule_json),
      updated_at: r.updated_at,
      updated_by: r.updated_by,
    };
  }
  return out;
}

/**
 * Validate + upsert. Returns the normalized stored schedule.
 */
export async function saveDefaultScheduleForType(env, quoteType, schedule, user) {
  if (!quoteType) throw new Error('quote_type is required');
  const normalized = normalizeSchedule(schedule);
  const json = JSON.stringify(normalized);
  await run(env.DB,
    `INSERT INTO quote_payment_schedule_defaults
       (quote_type, schedule_json, updated_at, updated_by)
     VALUES
       (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)
     ON CONFLICT(quote_type) DO UPDATE SET
       schedule_json = excluded.schedule_json,
       updated_at    = excluded.updated_at,
       updated_by    = excluded.updated_by`,
    [quoteType, json, user?.id ?? null]);
  return normalized;
}
