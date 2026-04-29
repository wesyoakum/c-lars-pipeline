-- 0056_notifications.sql
--
-- Phase 7 — external notifications. Teams webhooks + email
-- (transactional via Resend) get an opt-in matrix per user. The
-- existing in-app notification bell stays as-is — these tables are
-- purely for external delivery.
--
-- Three tables:
--   user_notification_channels  — per-user delivery targets
--                                  (where to send: webhook URL or
--                                  email addr)
--   user_notification_prefs     — per-user × event × channel matrix
--                                  (what to send where)
--   notification_log            — audit + debug trail of every send
--
-- Plus two new columns on `users` for the daily-digest tick:
--   timezone           — IANA tz name (e.g. America/New_York)
--   digest_hour_local  — 0-23 hour at which the digest fires in
--                        the user's local time (default 4)

CREATE TABLE IF NOT EXISTS user_notification_channels (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel      TEXT NOT NULL,                 -- 'teams' | 'email'
  -- Teams: incoming webhook URL.
  -- Email: explicit address (defaults to users.email if NULL on send).
  target       TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  -- Used by the "Test" button in the settings UI.
  last_test_at TEXT,
  last_test_ok INTEGER,                       -- 0/1 outcome of last test
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_notif_channels_user
  ON user_notification_channels(user_id, active);

CREATE TABLE IF NOT EXISTS user_notification_prefs (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,                   -- see notify.js for the enum
  channel    TEXT NOT NULL,                   -- 'teams' | 'email'
  enabled    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, event_type, channel)
);

CREATE TABLE IF NOT EXISTS notification_log (
  id            TEXT PRIMARY KEY,
  user_id       TEXT,                          -- nullable: digest could go to many
  event_type    TEXT NOT NULL,
  channel       TEXT NOT NULL,
  target        TEXT,                          -- the URL/email used
  status        TEXT NOT NULL,                 -- 'sent' | 'failed' | 'skipped'
  error_message TEXT,
  -- Idempotency key — same event + same target shouldn't get sent
  -- twice. Built by the caller; null when not applicable.
  idempotency_key TEXT,
  -- Trimmed copy of what was sent, for debugging.
  payload_preview TEXT,
  -- Optional context — entity that triggered the notification.
  ref_type      TEXT,
  ref_id        TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_log_user_created
  ON notification_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_log_idempotency
  ON notification_log(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Daily-digest timing on users.
ALTER TABLE users ADD COLUMN timezone TEXT;
ALTER TABLE users ADD COLUMN digest_hour_local INTEGER;
