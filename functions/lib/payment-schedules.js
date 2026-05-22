// functions/lib/payment-schedules.js
//
// Fixed-percentage payment schedules for non-New Product quote types (spares,
// service, refurb_baseline, refurb_modified). Unlike the New Product schedule,
// these have no delivery-weeks math — just percent + label rows.
//
// Stored as a JSON blob in site_prefs.payment_schedules, keyed by
// quote type. Each type's value is { rows: [{ percent, label }] }.

import { one, run } from './db.js';
import { auditStmt } from './audit.js';

export const SCHEDULE_TYPES = ['spares', 'service', 'refurb_baseline', 'refurb_modified'];

export const SCHEDULE_TYPE_LABELS = {
  spares: 'Spares',
  service: 'Service',
  refurb_baseline: 'Refurb — Base',
  refurb_modified: 'Refurb — Mod',
};

/**
 * Default schedules seeded when no admin config exists yet.
 */
export const DEFAULT_SCHEDULES = {
  spares: {
    rows: [
      { percent: 50, label: 'Due upon receipt of purchase order.' },
      { percent: 50, label: 'Due upon delivery, payable Net 15.' },
    ],
  },
  service: {
    rows: [
      { percent: 50, label: 'Due upon receipt of purchase order (estimated price).' },
      { percent: 50, label: 'Due upon completion of work, payable Net 15.' },
    ],
  },
  refurb_baseline: {
    rows: [
      { percent: 50, label: 'Due upon receipt of purchase order.' },
      { percent: 50, label: 'Due upon completion and delivery, payable Net 15.' },
    ],
  },
  refurb_modified: {
    rows: [
      { percent: 50, label: 'Due upon receipt of purchase order.' },
      { percent: 50, label: 'Due upon completion and delivery, payable Net 15.' },
    ],
  },
};

/**
 * Load all payment schedules from site_prefs. Returns a plain object
 * keyed by quote type, each with a `rows` array. Missing types get
 * their default.
 */
export async function loadPaymentSchedules(env) {
  const row = await one(env.DB, 'SELECT payment_schedules FROM site_prefs WHERE id = 1');
  let stored = {};
  if (row?.payment_schedules) {
    try { stored = JSON.parse(row.payment_schedules); } catch (_) {}
  }
  const out = {};
  for (const type of SCHEDULE_TYPES) {
    const s = stored[type];
    if (s && Array.isArray(s.rows) && s.rows.length > 0) {
      out[type] = s;
    } else {
      out[type] = DEFAULT_SCHEDULES[type] || { rows: [] };
    }
  }
  return out;
}

/**
 * Validate a single schedule object. Throws on bad input.
 */
export function validateSchedule(schedule) {
  if (!schedule || !Array.isArray(schedule.rows)) {
    throw new Error('Schedule must have a rows array');
  }
  if (schedule.rows.length === 0) throw new Error('Schedule must have at least one row');
  let sum = 0;
  for (const r of schedule.rows) {
    const p = Number(r.percent);
    if (!Number.isFinite(p) || p <= 0 || p > 100) {
      throw new Error(`Invalid percentage: ${r.percent}`);
    }
    if (!r.label || !String(r.label).trim()) {
      throw new Error('Every row must have a label');
    }
    sum += p;
  }
  if (Math.abs(sum - 100) > 0.01) {
    throw new Error(`Percentages sum to ${sum}, must equal 100`);
  }
}

/**
 * Render a schedule to a multi-line payment terms string.
 */
export function renderScheduleText(schedule) {
  if (!schedule || !Array.isArray(schedule.rows)) return '';
  return schedule.rows
    .map(r => `${r.percent}% ${r.label}`)
    .join('\n');
}

/**
 * Save a single type's schedule to site_prefs.payment_schedules.
 */
export async function saveSchedule(env, quoteType, schedule, user) {
  if (!SCHEDULE_TYPES.includes(quoteType)) {
    throw new Error(`Unknown schedule type: ${quoteType}`);
  }
  validateSchedule(schedule);

  const row = await one(env.DB, 'SELECT payment_schedules FROM site_prefs WHERE id = 1');
  let stored = {};
  if (row?.payment_schedules) {
    try { stored = JSON.parse(row.payment_schedules); } catch (_) {}
  }
  const previous = JSON.stringify(stored[quoteType] || null);
  stored[quoteType] = {
    rows: schedule.rows.map(r => ({
      percent: Number(r.percent),
      label: String(r.label).trim(),
    })),
  };
  const json = JSON.stringify(stored);

  await run(env.DB,
    `UPDATE site_prefs SET payment_schedules = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1`,
    [json]
  );

  return { ok: true };
}
