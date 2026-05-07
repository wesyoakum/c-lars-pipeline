// functions/lib/audit.js
//
// Single writer for the audit_events table. Every mutation in Pipeline
// (create, update, delete, stage_changed, quote_submitted, oc_issued,
// ntp_issued, handed_off, document uploaded, etc.) goes through this
// helper so we have one canonical change log per entity and per user.
//
// Usage:
//   import { audit, auditStmt } from '../lib/audit.js';
//
//   // Standalone (runs its own statement)
//   await audit(env.DB, {
//     entityType: 'account',
//     entityId: accountId,
//     eventType: 'created',
//     user,
//     summary: `Created account ${name}`,
//   });
//
//   // Composed into a D1 batch so the audit row is atomic with the change
//   const statements = [
//     stmt(env.DB, 'INSERT INTO accounts ...', [...]),
//     auditStmt(env.DB, { entityType: 'account', entityId, eventType: 'created', user, summary }),
//   ];
//   await env.DB.batch(statements);
//
// For Claudia event fan-out, prefer auditAndQueue() / auditStmtAndQueue()
// (defined below). They take `env` instead of `env.DB` so the helper
// can also publish to the Claudia event queue after the audit row
// writes. The publish is best-effort and never throws.

import { run, stmt } from './db.js';
import { uuid, now } from './ids.js';
import { queueClaudiaEvent } from './claudia-events.js';

/**
 * Build the arguments shared by both write paths. Returns an object
 * { id, sql, params } where params is in the order matching the SQL.
 */
function build({ entityType, entityId, eventType, user, summary, changes, overrideReason }) {
  if (!entityType) throw new Error('audit: entityType is required');
  if (!entityId) throw new Error('audit: entityId is required');
  if (!eventType) throw new Error('audit: eventType is required');

  const id = uuid();
  const at = now();
  const userId = user?.id ?? null;
  const changesJson =
    changes === undefined || changes === null ? null : JSON.stringify(changes);

  const sql = `
    INSERT INTO audit_events
      (id, entity_type, entity_id, event_type, user_id, at, summary, changes_json, override_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const params = [
    id,
    entityType,
    entityId,
    eventType,
    userId,
    at,
    summary ?? null,
    changesJson,
    overrideReason ?? null,
  ];

  return { id, sql, params };
}

/**
 * Write an audit event in its own statement.
 */
export async function audit(db, opts) {
  const { sql, params } = build(opts);
  await run(db, sql, params);
}

/**
 * Build a D1PreparedStatement so the audit row can be bundled into the
 * same db.batch() as the primary mutation. This is preferred for
 * anything more important than list-ordering changes, because it makes
 * the audit atomic with the change.
 */
export function auditStmt(db, opts) {
  const { sql, params } = build(opts);
  return stmt(db, sql, params);
}

/**
 * Compute a `changes` diff object { field: { from, to } } from two
 * plain objects, using `fields` as the whitelist. Values that are
 * identical are omitted. Useful for PATCH/PUT handlers.
 */
export function diff(before, after, fields) {
  const out = {};
  for (const f of fields) {
    const a = before?.[f];
    const b = after?.[f];
    if (a !== b) out[f] = { from: a ?? null, to: b ?? null };
  }
  return Object.keys(out).length ? out : null;
}

// ─────────────────────────────────────────────────────────────────────
// Claudia event fan-out
// ─────────────────────────────────────────────────────────────────────
//
// Most mutation handlers in the app already write an audit_events row.
// auditAndQueue() / auditStmtAndQueue() let those handlers ALSO publish
// a Claudia event with one extra line of code (and pass `env` instead
// of `env.DB`). The published event lands in claudia_events_pending +
// the Cloudflare Queue; the consumer worker picks it up and decides
// whether to extract actions, narrate, or noop.
//
// Deny-list entity types here are not fanned out — they're either
// internal to Claudia herself (would loop) or too noisy to be worth
// a model call. Add to it conservatively as we see noise; default is
// "fan out everything that gets audited."

const CLAUDIA_QUEUE_DENY = new Set([
  // Claudia's own state changes — would create a feedback loop where
  // every re-evaluation re-triggers itself.
  'claudia_action',
  'claudia_observation',
  'claudia_question',
  'claudia_triage_item', // legacy; safe to keep on the deny-list.
  'claudia_brief',
  'claudia_event_pending',
]);

function shouldQueueForClaudia(entityType) {
  return !CLAUDIA_QUEUE_DENY.has(entityType);
}

function dispatchType(entityType, eventType) {
  return `${entityType}.${eventType}`;
}

/**
 * Like audit() but ALSO publishes a Claudia event after the row writes.
 * The publish is best-effort (queueClaudiaEvent itself swallows
 * failures) and never throws.
 *
 * @param {object} env  Pages context env (must have env.DB; env.CLAUDIA_EVENTS optional).
 * @param {object} opts Same shape as audit().
 */
export async function auditAndQueue(env, opts) {
  const { sql, params } = build(opts);
  await run(env.DB, sql, params);
  if (!shouldQueueForClaudia(opts.entityType)) return;
  try {
    await queueClaudiaEvent(
      env,
      opts.user,
      dispatchType(opts.entityType, opts.eventType),
      opts.entityId,
      opts.summary
    );
  } catch (err) {
    console.warn('[audit] queue dispatch failed:', err?.message || err);
  }
}

/**
 * For batch callers: returns the audit prepared statement plus an
 * async `afterBatch()` that publishes the Claudia event. Call
 * afterBatch() AFTER the db.batch() resolves — only then do we know
 * the audited mutation actually committed.
 *
 * Usage:
 *   const { stmt: auditS, afterBatch } = auditStmtAndQueue(env, opts);
 *   await env.DB.batch([..., auditS]);
 *   await afterBatch();
 */
export function auditStmtAndQueue(env, opts) {
  const auditS = auditStmt(env.DB, opts);
  return {
    stmt: auditS,
    afterBatch: async () => {
      if (!shouldQueueForClaudia(opts.entityType)) return;
      try {
        await queueClaudiaEvent(
          env,
          opts.user,
          dispatchType(opts.entityType, opts.eventType),
          opts.entityId,
          opts.summary
        );
      } catch (err) {
        console.warn('[audit] queue dispatch (batch) failed:', err?.message || err);
      }
    },
  };
}
