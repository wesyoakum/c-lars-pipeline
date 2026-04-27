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

import { run, stmt } from './db.js';
import { uuid, now } from './ids.js';

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
