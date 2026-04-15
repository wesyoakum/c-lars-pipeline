-- 0029_activity_reminders.sql
--
-- Add an optional reminder timestamp to activities.
--
-- The new "Add task" modal lets the user pick a reminder time. When
-- remind_at has passed and reminder_notified_at is still NULL, the
-- reminder worker (future) should create a notification row for the
-- assigned user and stamp reminder_notified_at so we don't fire twice.
--
-- For now the column is just stored; the notification dispatch hook
-- will be added in a follow-up. Keeping the schema ready so we don't
-- have to migrate data later.

ALTER TABLE activities ADD COLUMN remind_at TEXT;
ALTER TABLE activities ADD COLUMN reminder_notified_at TEXT;

-- Index for the (future) reminder worker: "give me all pending tasks
-- with a remind_at in the past that haven't fired yet".
CREATE INDEX IF NOT EXISTS idx_activities_reminder_pending
  ON activities(remind_at)
  WHERE remind_at IS NOT NULL AND reminder_notified_at IS NULL;
