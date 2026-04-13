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
 * Allocate the next integer for a scope from the `sequences` table.
 *
 * Uses UPDATE...RETURNING which D1 supports (SQLite 3.35+). If the scope
 * row doesn't exist yet, an INSERT OR IGNORE fallback seeds it at 2 and
 * retries (so the first allocated value for a brand-new scope is 1).
 *
 * The caller decides how to format the result — see `nextNumber()` (the
 * legacy zero-padded prefixed format used by quotes/jobs) and the call
 * site in functions/opportunities/index.js (which uses the bare integer
 * directly for the new 5-digit opportunity number scheme).
 *
 * Collisions are still possible because D1 auto-commits per statement
 * and we can't span a transaction across this allocation + the insert
 * that consumes it. The UNIQUE index on the consuming column catches
 * any duplicate at insert time, which surfaces as a normal validation
 * error to the user.
 */
export async function nextSequenceValue(db, scope) {
  let row = await one(
    db,
    'UPDATE sequences SET next_value = next_value + 1 WHERE scope = ? RETURNING next_value',
    [scope]
  );

  if (!row) {
    await run(db, 'INSERT OR IGNORE INTO sequences (scope, next_value) VALUES (?, 2)', [scope]);
    row = await one(
      db,
      'SELECT next_value FROM sequences WHERE scope = ?',
      [scope]
    );
  }

  // next_value has already been incremented; the *allocated* number is (next_value - 1).
  return Number(row.next_value) - 1;
}

/**
 * Allocate the next number for a scope and return a zero-padded prefixed
 * string like `Q-2026-0001`. Used by quotes and jobs (and originally by
 * opportunities, before they switched to a bare 5-digit number).
 */
export async function nextNumber(db, scope) {
  const allocated = await nextSequenceValue(db, scope);
  return `${scope}-${String(allocated).padStart(4, '0')}`;
}

/**
 * Convenience: returns the current year as a 4-digit string.
 * Used to build scopes like `OPP-${currentYear()}`.
 */
export function currentYear() {
  return String(new Date().getUTCFullYear());
}

/**
 * Given a set of existing revision letters (e.g. ['A', 'B']), return
 * the next one in sequence ('C'). Handles single-letter revisions for
 * the common case; falls back to multi-letter ('Z' → 'AA' → 'AB' ...)
 * which is unlikely but keeps the function total.
 */
export function nextRevisionLetter(existing) {
  if (!existing || existing.length === 0) return 'A';

  const sorted = [...existing].sort((a, b) => {
    if (a.length !== b.length) return a.length - b.length;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const highest = sorted[sorted.length - 1] ?? 'A';

  if (highest.length === 1) {
    const code = highest.charCodeAt(0);
    if (code >= 65 && code < 90) return String.fromCharCode(code + 1);
    if (highest === 'Z') return 'AA';
  }

  const chars = highest.split('');
  let i = chars.length - 1;
  while (i >= 0) {
    if (chars[i] === 'Z') {
      chars[i] = 'A';
      i--;
    } else {
      chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1);
      return chars.join('');
    }
  }
  return 'A' + chars.join('');
}
