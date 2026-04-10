// functions/lib/db.js
//
// Tiny D1 convenience wrappers so route handlers read more naturally than
// context.env.DB.prepare(...).bind(...).first(). These are intentionally
// thin — D1's prepared-statement API is already good, we just want shorter
// names and consistent error shape at the call sites.
//
// Usage:
//   import { one, all, run, batch } from '../lib/db.js';
//   const user = await one(env.DB, 'SELECT * FROM users WHERE id = ?', [id]);
//   const rows = await all(env.DB, 'SELECT * FROM opportunities');
//   await run(env.DB, 'UPDATE users SET active = 0 WHERE id = ?', [id]);

/**
 * Run a SELECT expecting one row (or null).
 */
export async function one(db, sql, params = []) {
  return db.prepare(sql).bind(...params).first();
}

/**
 * Run a SELECT expecting many rows. Returns the results array (never null).
 */
export async function all(db, sql, params = []) {
  const { results } = await db.prepare(sql).bind(...params).all();
  return results ?? [];
}

/**
 * Run an INSERT / UPDATE / DELETE and return the D1 meta object
 * ({ changes, last_row_id, ... }).
 */
export async function run(db, sql, params = []) {
  const result = await db.prepare(sql).bind(...params).run();
  return result.meta ?? result;
}

/**
 * Build a prepared statement you can push into a batch() array.
 * Returns the D1PreparedStatement so callers can compose batches atomically.
 */
export function stmt(db, sql, params = []) {
  return db.prepare(sql).bind(...params);
}

/**
 * Execute several prepared statements as a single atomic batch.
 * Accepts an array of D1PreparedStatement (from stmt() above).
 */
export async function batch(db, statements) {
  return db.batch(statements);
}
