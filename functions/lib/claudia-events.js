// functions/lib/claudia-events.js
//
// Tiny helper that PMS route handlers call to enqueue a "something
// state-meaningful just happened" event for the hourly Claudia tick to
// consider. Designed to be lightweight (one INSERT) and best-effort —
// failures are swallowed so a queueing hiccup never breaks the actual
// Pipeline action that triggered it.
//
// Wire the call AFTER the underlying UPDATE/INSERT has succeeded —
// otherwise we'd queue events for changes that ended up rolling back.
// Keep the summary short (it shows up in Claudia's hourly context).

import { run } from './db.js';
import { now, uuid } from './ids.js';

/**
 * Enqueue a Claudia event. Best-effort — never throws.
 *
 * @param {object} env       — Pages context env (must have env.DB).
 * @param {object|null} user — actor; if null, no-op.
 * @param {string} type      — short kind tag, e.g. 'opp_stage_change', 'task_completed'.
 * @param {string|null} refId — affected entity id (opp id, activity id).
 * @param {string} summary   — one-line human-readable, e.g. 'WFM02-25314 → quote_under_revision'.
 */
export async function queueClaudiaEvent(env, user, type, refId, summary) {
  if (!env?.DB || !user?.id || !type) return;
  try {
    await run(
      env.DB,
      `INSERT INTO claudia_events_pending (id, user_id, type, ref_id, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [uuid(), user.id, String(type), refId ?? null, summary ?? null, now()]
    );
  } catch (err) {
    // Swallow — never break the parent action just because the queue insert failed.
    console.warn('[claudia-events] queue failed:', err?.message || err);
  }
}
