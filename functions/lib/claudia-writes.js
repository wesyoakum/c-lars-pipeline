// functions/lib/claudia-writes.js
//
// Write helpers used by the Claudia write tools (create_contact,
// update_contact, create_account, ...). Every write goes through one
// of these wrappers so the audit log row is always created together
// with the underlying INSERT/UPDATE — there is no path to mutate
// allowed tables without producing an audit entry.
//
// undo_claudia_write() reverses an audit row: deletes the row that
// was created, or restores the prior snapshot for an update. The
// 24-hour undo window is enforced here, not in the tool definition,
// so the policy can't be bypassed.

import { all, one, run, batch as d1Batch, stmt } from './db.js';
import { now, uuid } from './ids.js';
import { auditStmt, diff as auditDiff } from './audit.js';

// Map a writable table name to the entity_type used in the standard
// audit_events trail. Pipeline's existing handlers use these singulars
// (account, contact) — keep them aligned so Claudia's changes show up
// alongside human-driven ones in any history view.
const ENTITY_TYPE_BY_TABLE = {
  accounts: 'account',
  contacts: 'contact',
};

// Whitelisted fields per table for the diff computation on UPDATEs.
// Anything not in this list is excluded from the audit_events
// changes_json — keeps timestamps and IDs out of the trail.
const AUDIT_FIELDS_BY_TABLE = {
  accounts: ['name', 'segment', 'alias', 'parent_group', 'owner_user_id',
    'phone', 'website', 'email', 'notes', 'address_billing', 'address_physical',
    'is_active'],
  contacts: ['account_id', 'first_name', 'last_name', 'title', 'email', 'phone',
    'mobile', 'is_primary', 'notes'],
};

const UNDO_WINDOW_HOURS = 24;

// Tables Claudia is allowed to write to. Anything else is rejected.
// Add intentionally; do NOT add opportunities/quotes/jobs without a
// matching read-back + audit pattern in tools.js.
const WRITABLE_TABLES = new Set(['contacts', 'accounts']);

/**
 * Insert a new row + log to claudia_writes in a single batch.
 *
 * @param {object} env
 * @param {object} user
 * @param {string} action       — short tag, e.g. 'create_contact'
 * @param {string} table        — must be in WRITABLE_TABLES
 * @param {string} id           — primary key of the new row (caller mints uuid)
 * @param {object} columnValues — { col: value, ... } to INSERT
 * @param {object} [opts]
 * @param {string} [opts.batchId]  — group multiple writes for batch undo
 * @param {string} [opts.summary]  — one-line human description
 * @returns {Promise<{ id, audit_id, action, ref_table, ref_id, after }>}
 */
export async function claudiaInsert(env, user, action, table, id, columnValues, opts = {}) {
  if (!WRITABLE_TABLES.has(table)) {
    throw new Error(`claudiaInsert: table '${table}' is not on the write allowlist.`);
  }
  if (!id) throw new Error('claudiaInsert requires an id.');
  const fullRow = { id, ...columnValues };
  const cols = Object.keys(fullRow);
  const placeholders = cols.map(() => '?').join(', ');
  const insertSql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
  const insertParams = cols.map((c) => fullRow[c]);

  const claudiaAuditId = uuid();
  const ts = now();
  const claudiaWriteSql = `INSERT INTO claudia_writes
    (id, user_id, action, ref_table, ref_id, before_json, after_json, batch_id, summary, created_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`;
  const claudiaWriteParams = [
    claudiaAuditId, user.id, action, table, id,
    JSON.stringify(fullRow),
    opts.batchId ?? null,
    opts.summary ?? null,
    ts,
  ];

  // Also write to the standard Pipeline audit_events table so the
  // change shows up in the normal history trail (alongside writes
  // made via the regular UI). user_id is the human Claudia acted on
  // behalf of; the summary tags it as "(via Claudia)" so anyone
  // reviewing the history can tell.
  const stmts = [
    stmt(env.DB, insertSql, insertParams),
    stmt(env.DB, claudiaWriteSql, claudiaWriteParams),
  ];
  const entityType = ENTITY_TYPE_BY_TABLE[table];
  if (entityType) {
    stmts.push(auditStmt(env.DB, {
      entityType,
      entityId: id,
      eventType: 'created',
      user,
      summary: ((opts.summary || `created ${entityType} ${id}`) + ' (via Claudia)').slice(0, 500),
    }));
  }

  await d1Batch(env.DB, stmts);
  return { id, audit_id: claudiaAuditId, action, ref_table: table, ref_id: id, after: fullRow };
}

/**
 * Update an existing row + log to claudia_writes. Snapshots the row
 * BEFORE the update so undo can restore it exactly.
 *
 * @param {object} env
 * @param {object} user
 * @param {string} action
 * @param {string} table
 * @param {string} id
 * @param {object} columnValues  — { col: newValue, ... } only the cols to change
 * @param {object} [opts]
 * @returns {Promise<{ id, audit_id, before, after, diffs }>}
 */
export async function claudiaUpdate(env, user, action, table, id, columnValues, opts = {}) {
  if (!WRITABLE_TABLES.has(table)) {
    throw new Error(`claudiaUpdate: table '${table}' is not on the write allowlist.`);
  }
  if (!id) throw new Error('claudiaUpdate requires an id.');
  if (!columnValues || Object.keys(columnValues).length === 0) {
    throw new Error('claudiaUpdate requires at least one column to change.');
  }

  const before = await one(env.DB, `SELECT * FROM ${table} WHERE id = ?`, [id]);
  if (!before) throw new Error(`claudiaUpdate: no row in ${table} with id ${id}.`);

  // Diff first — skip the write entirely if nothing actually changes.
  const diffs = {};
  for (const [k, v] of Object.entries(columnValues)) {
    if (before[k] !== v) diffs[k] = { from: before[k] ?? null, to: v };
  }
  if (Object.keys(diffs).length === 0) {
    return { id, audit_id: null, before, after: before, diffs: {}, no_change: true };
  }

  const ts = now();
  // Bump updated_at on tables that have it.
  const setCols = Object.keys(columnValues);
  if ('updated_at' in before && !('updated_at' in columnValues)) {
    setCols.push('updated_at');
    columnValues = { ...columnValues, updated_at: ts };
  }
  const setSql = setCols.map((c) => `${c} = ?`).join(', ');
  const updateSql = `UPDATE ${table} SET ${setSql} WHERE id = ?`;
  const updateParams = [...setCols.map((c) => columnValues[c]), id];

  const after = { ...before, ...columnValues };

  const claudiaAuditId = uuid();
  const claudiaWriteSql = `INSERT INTO claudia_writes
    (id, user_id, action, ref_table, ref_id, before_json, after_json, batch_id, summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const claudiaWriteParams = [
    claudiaAuditId, user.id, action, table, id,
    JSON.stringify(before),
    JSON.stringify(after),
    opts.batchId ?? null,
    opts.summary ?? null,
    ts,
  ];

  // Standard Pipeline audit trail too (changes-aware diff so the
  // history view can show field-level deltas, same shape regular UI
  // handlers produce).
  const stmts = [
    stmt(env.DB, updateSql, updateParams),
    stmt(env.DB, claudiaWriteSql, claudiaWriteParams),
  ];
  const entityType = ENTITY_TYPE_BY_TABLE[table];
  const fields = AUDIT_FIELDS_BY_TABLE[table];
  if (entityType && fields) {
    const auditableDiff = auditDiff(before, after, fields);
    if (auditableDiff) {
      stmts.push(auditStmt(env.DB, {
        entityType,
        entityId: id,
        eventType: 'updated',
        user,
        summary: ((opts.summary || `updated ${entityType} ${id}`) + ' (via Claudia)').slice(0, 500),
        changes: auditableDiff,
      }));
    }
  }

  await d1Batch(env.DB, stmts);
  return { id, audit_id: claudiaAuditId, before, after, diffs };
}

/**
 * Reverse an audited write. For a CREATE: delete the row. For an
 * UPDATE: restore the before snapshot. The 24-hour window is enforced
 * here. Marks the audit row undone (does not delete it).
 *
 * @param {object} env
 * @param {object} user
 * @param {string} auditId
 * @param {object} [opts]
 * @param {string} [opts.reason]
 * @returns {Promise<{ ok, action, ref_table, ref_id, undone_at }>}
 */
export async function claudiaUndo(env, user, auditId, opts = {}) {
  const audit = await one(
    env.DB,
    `SELECT * FROM claudia_writes WHERE id = ? AND user_id = ?`,
    [auditId, user.id]
  );
  if (!audit) return { error: 'not_found', audit_id: auditId };
  if (audit.undone_at) return { error: 'already_undone', audit_id: auditId, undone_at: audit.undone_at };

  const ageHours = (Date.now() - Date.parse(audit.created_at)) / 3600000;
  if (ageHours > UNDO_WINDOW_HOURS) {
    return {
      error: 'undo_window_expired',
      audit_id: auditId,
      age_hours: Math.round(ageHours),
      window_hours: UNDO_WINDOW_HOURS,
    };
  }
  if (!WRITABLE_TABLES.has(audit.ref_table)) {
    return { error: 'table_not_writable', ref_table: audit.ref_table };
  }

  const ts = now();
  let reverseStmt;
  if (audit.before_json == null) {
    // Original was a CREATE — undo by deleting the row.
    reverseStmt = stmt(
      env.DB,
      `DELETE FROM ${audit.ref_table} WHERE id = ?`,
      [audit.ref_id]
    );
  } else {
    // Original was an UPDATE — restore the before snapshot.
    let before;
    try { before = JSON.parse(audit.before_json); } catch { before = null; }
    if (!before) return { error: 'before_snapshot_unparseable', audit_id: auditId };
    const cols = Object.keys(before).filter((k) => k !== 'id');
    if (cols.length === 0) return { error: 'before_snapshot_empty', audit_id: auditId };
    const setSql = cols.map((c) => `${c} = ?`).join(', ');
    reverseStmt = stmt(
      env.DB,
      `UPDATE ${audit.ref_table} SET ${setSql} WHERE id = ?`,
      [...cols.map((c) => before[c]), audit.ref_id]
    );
  }

  const markUndoneStmt = stmt(
    env.DB,
    `UPDATE claudia_writes SET undone_at = ?, undo_reason = ? WHERE id = ?`,
    [ts, opts.reason ?? null, auditId]
  );

  // Also reflect the undo in the standard audit_events trail so the
  // history view shows the create + the revert (or update + the
  // revert) in chronological order.
  const stmts = [reverseStmt, markUndoneStmt];
  const entityType = ENTITY_TYPE_BY_TABLE[audit.ref_table];
  if (entityType) {
    const reasonNote = opts.reason ? ` — ${opts.reason}` : '';
    const eventType = audit.before_json == null ? 'created_reverted' : 'updated_reverted';
    stmts.push(auditStmt(env.DB, {
      entityType,
      entityId: audit.ref_id,
      eventType,
      user,
      summary: `Reverted Claudia write ${audit.action}${reasonNote} (via Claudia undo)`.slice(0, 500),
    }));
  }

  await d1Batch(env.DB, stmts);

  return {
    ok: true,
    action: audit.action,
    ref_table: audit.ref_table,
    ref_id: audit.ref_id,
    undone_at: ts,
  };
}

/**
 * Convenience: list recent writes for the user, newest first.
 */
export async function claudiaListRecentWrites(env, user, limit = 25) {
  return all(
    env.DB,
    `SELECT id, action, ref_table, ref_id, batch_id, summary, created_at, undone_at
       FROM claudia_writes
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ?`,
    [user.id, Math.min(Math.max(Number(limit) || 25, 1), 200)]
  );
}

export const CLAUDIA_WRITES = {
  WRITABLE_TABLES: Array.from(WRITABLE_TABLES),
  UNDO_WINDOW_HOURS,
};
