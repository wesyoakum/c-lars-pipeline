-- 0100: Add session_notify_user_ids to site_prefs.
-- JSON array of user IDs who receive a Teams notification when any user
-- starts a new session (>30 min idle gap). Admin-configurable from the
-- Activity settings page.
ALTER TABLE site_prefs ADD COLUMN session_notify_user_ids TEXT;
