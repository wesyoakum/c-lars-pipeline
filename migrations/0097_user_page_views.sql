-- 0097: User activity tracking — page views + last_seen_at
--
-- Logs every authenticated page view for admin-only activity monitoring.
-- Also adds last_seen_at to users for a quick "active now" indicator.

CREATE TABLE IF NOT EXISTS user_page_views (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  url        TEXT NOT NULL,
  at         TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_page_views_user_at ON user_page_views(user_id, at DESC);

ALTER TABLE users ADD COLUMN last_seen_at TEXT;
