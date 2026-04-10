// functions/lib/ids.js
//
// UUID generation and human-readable number allocation.
//
// UUIDs are used as primary keys everywhere. Human-readable numbers
// (OPP-2026-0001, Q-2026-0012, JOB-2026-0003) are generated from the
// `sequences` table via an atomic UPDATE...RETURNING.

import { one, run } from './db.js';

/**
 * Generate a random UUID (v4). Workers runtime has crypto.randomUUID() built in.
 */
export function uuid() {
  return crypto.randomUUID();
}

/**
 * Current ISO-8601 UTC timestamp string, matching the SQLite default.
 */
export function now() {
  return new Date().toISOString();
}

/**
 * Allocate the next number for a scope (e.g. 'OPP-2026') and return a
 * formatted string 'OPP-2026-0001'.
 *
 * Uses UPDATE...RETURNING which D1 supports (SQLite 3.35+). If the scope
 * row doesn't exist yet, an INSERT OR IGNORE fallback seeds it at 1 and
 * retries.
 *
 * Callers should invoke this inside the same logical transaction as the
 * row they're inserting, but because D1 auto-commits per statement we
 * can't enforce true serializable here in P0. Collisions are vanishingly
 * unlikely for a solo-user system and a UNIQUE index on `number` would
 * catch any duplicates at insert time.
 */
export async function nextNumber(db, scope) {
  // Try to increment atomically.
  let row = await one(
    db,
    'UPDATE sequences SET next_value = next_value + 1 WHERE scope = ? RETURNING next_value',
    [scope]
  );

  if (!row) {
    // Seed row and retry once.
    await run(db, 'INSERT OR IGNORE INTO sequences (scope, next_value) VALUES (?, 2)', [scope]);
    row = await one(
      db,
      'SELECT next_value FROM sequences WHERE scope = ?',
      [scope]
    );
  }

  // next_value has already been incremented; the *allocated* number is (next_value - 1).
  const allocated = Number(row.next_value) - 1;
  return `${scope}-${String(allocated).padStart(4, '0')}`;
}

/**
 * Convenience: returns the current year as a 4-digit string.
 * Used to build scopes like `OPP-${currentYear()}`.
 */
export function currentYear() {
  return String(new Date().getUTCFullYear());
}
