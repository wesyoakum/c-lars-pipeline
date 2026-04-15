// functions/lib/notify.js
//
// T4.2 Phase 1 — in-app notifications.
//
// Tiny wrapper around the `notifications` table (see migration 0022).
// Route handlers call `notify()` to create a row; the layout polls
// `getUnreadForUser()` every 30s via /notifications/unread and renders
// unread rows as toasts; clicking a toast hits /notifications/:id/read
// which calls `markRead()`.
//
// Usage:
//   import { notify } from '../lib/notify.js';
//   await notify(env.DB, {
//     userId:    opp.owner_id,
//     type:      'stage_changed',
//     title:     `Opportunity ${opp.number} moved to ${newStage}`,
//     body:      `${actor.display_name} changed the stage from ${oldStage}.`,
//     linkUrl:   `/opportunities/${opp.id}`,
//     entityType:'opportunity',
//     entityId:  opp.id,
//   });
//
// All fields except userId, type, title are optional. Failures are
// swallowed (logged to console) so a notification-insert error never
// breaks the parent write — notifications are auxiliary data.

import { one, all, run, stmt } from './db.js';
import { uuid, now } from './ids.js';

/**
 * Create a notification for a single user. Returns the new row's id on
 * success, or null if the insert failed (caller shouldn't care — we
 * intentionally don't throw, since failing a notification shouldn't
 * break the parent operation).
 */
export async function notify(db, {
  userId,
  type,
  title,
  body = null,
  linkUrl = null,
  entityType = null,
  entityId = null,
} = {}) {
  if (!db || !userId || !type || !title) return null;

  const id = uuid();
  const createdAt = now();

  try {
    await run(
      db,
      `INSERT INTO notifications
         (id, user_id, type, title, body, link_url, entity_type, entity_id, created_at, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [id, userId, type, title, body, linkUrl, entityType, entityId, createdAt]
    );
    return id;
  } catch (err) {
    console.error('notify() failed:', err?.message || err);
    return null;
  }
}

/**
 * Build a prepared INSERT statement for a notification so callers can
 * bundle it into an existing batch() without a second round-trip.
 *
 * Usage:
 *   statements.push(notifyStmt(env.DB, { userId, type, title, ... }));
 *   await batch(env.DB, statements);
 */
export function notifyStmt(db, {
  userId,
  type,
  title,
  body = null,
  linkUrl = null,
  entityType = null,
  entityId = null,
} = {}) {
  const id = uuid();
  const createdAt = now();
  return stmt(
    db,
    `INSERT INTO notifications
       (id, user_id, type, title, body, link_url, entity_type, entity_id, created_at, read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [id, userId, type, title, body, linkUrl, entityType, entityId, createdAt]
  );
}

/**
 * Return the user's unread notifications, newest first.
 * Used by the 30-second poll from the layout to refresh the toast stack
 * and the header bell-icon badge.
 */
export async function getUnreadForUser(db, userId, limit = 20) {
  if (!db || !userId) return [];
  return all(
    db,
    `SELECT id, type, title, body, link_url, entity_type, entity_id, created_at
       FROM notifications
      WHERE user_id = ? AND read_at IS NULL
   ORDER BY created_at DESC
      LIMIT ?`,
    [userId, limit]
  );
}

/**
 * Return the user's N most recent notifications (read + unread),
 * newest first. Used by the /notifications history page.
 */
export async function getRecentForUser(db, userId, limit = 100) {
  if (!db || !userId) return [];
  return all(
    db,
    `SELECT id, type, title, body, link_url, entity_type, entity_id, created_at, read_at
       FROM notifications
      WHERE user_id = ?
   ORDER BY created_at DESC
      LIMIT ?`,
    [userId, limit]
  );
}

/**
 * Return the count of unread notifications for a user. Used by the
 * bell-icon badge.
 */
export async function getUnreadCount(db, userId) {
  if (!db || !userId) return 0;
  const row = await one(
    db,
    'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL',
    [userId]
  );
  return Number(row?.n) || 0;
}

/**
 * Mark a notification as read. The user_id check in the WHERE clause
 * ensures user A can't mark user B's notifications read.
 * Returns true if a row was updated, false otherwise.
 */
export async function markRead(db, userId, notificationId) {
  if (!db || !userId || !notificationId) return false;
  const meta = await run(
    db,
    `UPDATE notifications
        SET read_at = ?
      WHERE id = ? AND user_id = ? AND read_at IS NULL`,
    [now(), notificationId, userId]
  );
  return (meta?.changes || 0) > 0;
}

/**
 * Mark ALL of a user's unread notifications as read. Used by the
 * "mark all read" button on the /notifications history page.
 */
export async function markAllRead(db, userId) {
  if (!db || !userId) return 0;
  const meta = await run(
    db,
    `UPDATE notifications
        SET read_at = ?
      WHERE user_id = ? AND read_at IS NULL`,
    [now(), userId]
  );
  return meta?.changes || 0;
}
