-- 0022_notifications.sql
--
-- T4.2 Phase 1 — In-app notifications.
--
-- Each row is one notification for one user. The UI polls
-- /notifications/unread every 30s, shows unread notifications as toasts
-- on first sight, and decrements the header bell-icon badge when the
-- user clicks one (which hits POST /notifications/:id/read).
--
-- Columns:
--   id          — uuid, primary key
--   user_id     — FK to users.id; the recipient
--   type        — short machine-readable tag: 'stage_changed',
--                 'quote_issued', 'task_overdue', etc. Future filters /
--                 user preferences can key off this.
--   title       — short headline (≤ 120 chars), rendered bold in the toast
--   body        — optional detail text (nullable)
--   link_url    — optional path to navigate to when the notification is
--                 clicked (e.g. /opportunities/abc-123)
--   entity_type — optional entity reference (opportunity, quote, job…)
--   entity_id   — optional uuid of the referenced entity
--   created_at  — ISO-8601 UTC, used for sort order
--   read_at     — ISO-8601 UTC when the user clicked / dismissed the
--                 notification. NULL until read.
--
-- Unread notifications = rows where read_at IS NULL. The UI poll just
-- does SELECT * FROM notifications WHERE user_id = ? AND read_at IS NULL.

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  link_url    TEXT,
  entity_type TEXT,
  entity_id   TEXT,
  created_at  TEXT NOT NULL,
  read_at     TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Most queries filter by user + unread. Sorting is always newest first.
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications(user_id, read_at, created_at DESC);

-- For the full history page: all of a user's notifications, newest first.
CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications(user_id, created_at DESC);
