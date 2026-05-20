// functions/lib/soft-delete.js
//
// Shared helpers for soft delete + restore. Every table with a
// deleted_at column uses UPDATE SET deleted_at = <timestamp> instead
// of DELETE FROM. Restore clears deleted_at back to NULL.
//
// Cascade soft-delete: when a parent is soft-deleted, its children
// are also soft-deleted. On restore, children are restored too.
//
// R2 files: left in place on soft delete (only purged on hard-delete
// or future expiry sweep).

import { stmt, run } from './db.js';
import { now } from './ids.js';

/**
 * Soft-delete a single row by setting deleted_at.
 * Returns a D1 prepared statement (for use in batch()).
 */
export function softDeleteStmt(db, table, id, ts = now()) {
  return stmt(db,
    `UPDATE ${table} SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`,
    [ts, id]
  );
}

/**
 * Soft-delete all rows in a child table where a parent FK matches.
 * E.g., softDeleteChildrenStmt(db, 'contacts', 'account_id', accountId)
 */
export function softDeleteChildrenStmt(db, table, fkColumn, parentId, ts = now()) {
  return stmt(db,
    `UPDATE ${table} SET deleted_at = ? WHERE ${fkColumn} = ? AND deleted_at IS NULL`,
    [ts, parentId]
  );
}

/**
 * Restore a single row by clearing deleted_at.
 */
export function restoreStmt(db, table, id) {
  return stmt(db,
    `UPDATE ${table} SET deleted_at = NULL WHERE id = ?`,
    [id]
  );
}

/**
 * Restore all children that were soft-deleted at the same timestamp
 * as the parent (i.e., cascade-deleted together).
 */
export function restoreChildrenStmt(db, table, fkColumn, parentId, deletedAt) {
  return stmt(db,
    `UPDATE ${table} SET deleted_at = NULL WHERE ${fkColumn} = ? AND deleted_at = ?`,
    [parentId, deletedAt]
  );
}

/**
 * Standard NOT-deleted filter for WHERE clauses.
 * Usage: `SELECT ... FROM foo WHERE ${notDeleted('foo')} AND ...`
 */
export function notDeleted(alias) {
  return `${alias}.deleted_at IS NULL`;
}
