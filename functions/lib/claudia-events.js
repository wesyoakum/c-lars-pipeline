// functions/lib/claudia-events.js
//
// Tiny helper that PMS route handlers call to enqueue a "something
// state-meaningful just happened" event for Claudia to consider.
// Designed to be lightweight (one INSERT + one queue send) and
// best-effort — failures are swallowed so a queueing hiccup never
// breaks the actual Pipeline action that triggered it.
//
// Wire the call AFTER the underlying UPDATE/INSERT has succeeded —
// otherwise we'd queue events for changes that ended up rolling back.
// Keep the summary short (it shows up in Claudia's context).
//
// Two writes happen:
//   1. INSERT into claudia_events_pending — durable record. The
//      hourly cron sweeps any rows still WHERE dispatched_at IS NULL
//      so events survive a queue-consumer outage.
//   2. send to env.CLAUDIA_EVENTS (Cloudflare Queue) — triggers the
//      claudia-consumer worker to process the event in near-real-time.
//
// Both writes are independent and best-effort; a failure on one does
// not prevent the other.

import { run } from './db.js';
import { now, uuid } from './ids.js';

/**
 * Enqueue a Claudia event. Best-effort — never throws.
 *
 * @param {object} env       — Pages context env (must have env.DB; env.CLAUDIA_EVENTS optional).
 * @param {object|null} user — actor; if null, no-op.
 * @param {string} type      — short kind tag, e.g. 'opportunity.stage_changed', 'document.email_ingested'.
 * @param {string|null} refId — affected entity id (opp id, activity id, doc id).
 * @param {string} summary   — one-line human-readable, e.g. 'WFM02-25314 → quote_under_revision'.
 * @returns {Promise<string|null>} — the inserted event id on success, null on failure.
 */
export async function queueClaudiaEvent(env, user, type, refId, summary) {
  if (!env?.DB || !user?.id || !type) return null;

  const eventId = uuid();
  let dbWriteOk = false;
  try {
    await run(
      env.DB,
      `INSERT INTO claudia_events_pending (id, user_id, type, ref_id, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [eventId, user.id, String(type), refId ?? null, summary ?? null, now()]
    );
    dbWriteOk = true;
  } catch (err) {
    // Swallow — never break the parent action just because the queue insert failed.
    console.warn('[claudia-events] D1 insert failed:', err?.message || err);
  }

  // Independent best-effort: publish to the queue if the binding is
  // present. If the D1 insert failed we still try the send, since the
  // consumer can re-fetch from D1 by event id and degrade gracefully.
  if (env?.CLAUDIA_EVENTS?.send) {
    try {
      await env.CLAUDIA_EVENTS.send({
        event_id: eventId,
        type: String(type),
        ref_id: refId ?? null,
        summary: summary ?? null,
        user_id: user.id,
        // Wall-clock timestamp at producer-send time. The consumer
        // uses it to detect stale messages on redrive.
        sent_at: now(),
      });
    } catch (err) {
      console.warn('[claudia-events] queue send failed:', err?.message || err);
    }
  }

  return dbWriteOk ? eventId : null;
}
