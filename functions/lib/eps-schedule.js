// functions/lib/eps-schedule.js
//
// Admin-editable EPS default payment schedule. Stored as a JSON blob
// on site_prefs.eps_schedule (migration 0040). Rendered client-side
// by the epsTerms Alpine component on the quote detail page, and
// server-side by any future quote-doc generator that needs the
// expanded string.
//
// Shape:
//   { rows: [ { percent, label, weeks_num?, weeks_den? }, … ] }
//
//   percent   — number in (0, 100]. All rows must sum to exactly 100.
//   label     — milestone description. If it contains "{weeks}",
//               weeks_num/weeks_den must both be set and the token
//               is replaced with floor(weeks_num * W / weeks_den),
//               where W is the quote's parsed delivery-weeks value.
//   weeks_num, weeks_den — positive integers; both set or both unset.

import { one, batch, stmt } from './db.js';
import { auditStmt } from './audit.js';

/**
 * Default 6-milestone EPS schedule. Used as the fallback when
 * site_prefs.eps_schedule is NULL. The percent column sums to 100
 * (10 + 15 + 30 + 20 + 20 + 5). Rows 3-6 use the {weeks} token —
 * substituted at render time via floor(weeks_num * W / weeks_den)
 * where W is the quote's delivery-weeks value.
 *
 * Milestone breakdown:
 *   1  10%  Order Confirmation
 *   2  15%  PDR / Production schedule released / Long-leads on order — fixed 4 weeks
 *   3  30%  Detailed Design Review + Purchasing Complete — ~30% of lead time
 *   4  20%  Fabrication Completion / Assembly Under Way — ~50% of lead time
 *   5  20%  FAT Completion — ~70% of lead time
 *   6   5%  Final Documentation Delivery — 100% of lead time
 */
export const DEFAULT_EPS_SCHEDULE = {
  rows: [
    {
      percent: 10,
      label: 'Due at Order Confirmation.',
    },
    {
      percent: 15,
      label: 'Due at Preliminary Design Review, Production Schedule Released, and Long-leads on order. 4 weeks after Order Confirmation.',
    },
    {
      percent: 30,
      label: 'Due at Detailed Design Review, and Purchasing Complete. Approx. {weeks} weeks after Order Confirmation.',
      weeks_num: 30, weeks_den: 100,
    },
    {
      percent: 20,
      label: 'Due at Fabrication Completion, and Assembly Under Way. Approx. {weeks} weeks after Order Confirmation.',
      weeks_num: 50, weeks_den: 100,
    },
    {
      percent: 20,
      label: 'Due at FAT Completion. Approx. {weeks} weeks after Order Confirmation.',
      weeks_num: 70, weeks_den: 100,
    },
    {
      percent: 5,
      label: 'Due at Final Documentation Delivery. {weeks} weeks from Order Confirmation.',
      weeks_num: 100, weeks_den: 100,
    },
  ],
};

/**
 * Read the current schedule from site_prefs. Returns a plain object
 * with a `rows` array. Falls back to DEFAULT_EPS_SCHEDULE if the
 * column is NULL or unparseable.
 */
export async function loadEpsSchedule(env) {
  const row = await one(env.DB, 'SELECT eps_schedule FROM site_prefs WHERE id = 1');
  const raw = row?.eps_schedule;
  if (!raw) return DEFAULT_EPS_SCHEDULE;
  try {
    const parsed = JSON.parse(raw);
    // Re-validate — a bad row shouldn't break every quote detail page.
    validateEpsSchedule(parsed);
    return parsed;
  } catch (_) {
    return DEFAULT_EPS_SCHEDULE;
  }
}

/**
 * Throws on a malformed schedule. Used on the admin save path and
 * also as a belt-and-suspenders check inside loadEpsSchedule.
 */
export function validateEpsSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') throw new Error('schedule must be an object');
  const rows = schedule.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('schedule.rows must be a non-empty array');
  }
  if (rows.length > 20) throw new Error('schedule has too many rows (max 20)');

  let sum = 0;
  rows.forEach((r, i) => {
    if (!r || typeof r !== 'object') throw new Error(`row ${i + 1}: not an object`);
    const p = Number(r.percent);
    if (!Number.isFinite(p) || p <= 0 || p > 100) {
      throw new Error(`row ${i + 1}: percent must be a positive number \u2264 100`);
    }
    sum += p;
    if (typeof r.label !== 'string' || r.label.trim() === '') {
      throw new Error(`row ${i + 1}: label must be a non-empty string`);
    }
    const hasNum = r.weeks_num != null && r.weeks_num !== '';
    const hasDen = r.weeks_den != null && r.weeks_den !== '';
    if (hasNum !== hasDen) {
      throw new Error(`row ${i + 1}: weeks_num and weeks_den must both be set or both omitted`);
    }
    if (hasNum) {
      const n = parseInt(r.weeks_num, 10);
      const d = parseInt(r.weeks_den, 10);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`row ${i + 1}: weeks_num must be a positive integer`);
      if (!Number.isInteger(d) || d <= 0) throw new Error(`row ${i + 1}: weeks_den must be a positive integer`);
    }
  });

  // Allow tiny FP drift (e.g. 33.33 + 33.33 + 33.34).
  if (Math.abs(sum - 100) > 0.01) {
    throw new Error(`percentages must sum to 100 (got ${sum})`);
  }
}

/**
 * Render a schedule into the multi-line string that populates the
 * EPS payment_terms textarea. Mirrors the old hardcoded JS exactly
 * so existing quotes compare equal to `useDefault === true`.
 *
 * Returns '' when deliveryWeeks is missing/zero AND any row needs a
 * weeks substitution — matches the old behavior (epsDefaultTerms
 * returned '' when weeks <= 0). If no row uses {weeks}, always
 * renders.
 */
export function epsScheduleToString(schedule, deliveryWeeks) {
  const rows = Array.isArray(schedule?.rows) ? schedule.rows : [];
  const needsWeeks = rows.some(r => r && r.weeks_num != null && r.weeks_den != null);
  const W = Number(deliveryWeeks);
  if (needsWeeks && (!Number.isFinite(W) || W <= 0)) return '';

  return rows.map(r => {
    const pct = formatPercent(r.percent);
    let label = String(r.label || '');
    if (r.weeks_num != null && r.weeks_den != null) {
      const n = parseInt(r.weeks_num, 10);
      const d = parseInt(r.weeks_den, 10);
      const weeks = Math.floor((n * W) / d);
      label = label.replace(/\{weeks\}/g, String(weeks));
    }
    return `${pct}% ${label}`;
  }).join('\n');
}

/** Render a percent without a trailing ".0" when it's whole. */
function formatPercent(p) {
  const n = Number(p);
  if (Number.isInteger(n)) return String(n);
  // Trim trailing zeros after 2-decimal cap.
  return n.toFixed(2).replace(/\.?0+$/, '');
}

/**
 * Admin save. Validates first, then upserts + audits. Pass the parsed
 * schedule object (the caller parses the POST body).
 */
export async function saveEpsSchedule(env, schedule, user) {
  validateEpsSchedule(schedule);
  // Normalize: re-serialize so the stored JSON has consistent shape
  // and drops any stray client-side keys.
  const normalized = {
    rows: schedule.rows.map(r => {
      const out = {
        percent: Number(r.percent),
        label: String(r.label),
      };
      if (r.weeks_num != null && r.weeks_num !== '') {
        out.weeks_num = parseInt(r.weeks_num, 10);
        out.weeks_den = parseInt(r.weeks_den, 10);
      }
      return out;
    }),
  };
  const json = JSON.stringify(normalized);

  const existing = await one(env.DB, 'SELECT eps_schedule FROM site_prefs WHERE id = 1');
  const previous = existing?.eps_schedule ?? '';

  await batch(env.DB, [
    stmt(
      env.DB,
      `UPDATE site_prefs
         SET eps_schedule = ?,
             updated_at   = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             updated_by   = ?
       WHERE id = 1`,
      [json, user?.id ?? null]
    ),
    auditStmt(env.DB, {
      entityType: 'site_prefs',
      entityId: '1',
      eventType: 'updated',
      user,
      summary: 'Updated EPS default payment schedule',
      changes: { eps_schedule: { from: previous, to: json } },
    }),
  ]);

  return normalized;
}
