-- 0059_user_sidebar_prefs.sql
--
-- Per-user toggles for the three right-rail sidebar widgets: To-Do
-- list, Coming Soon (upcoming tasks), and Post-Its. Some users want
-- a calmer canvas; others rely on every widget. All three default
-- to 1 (visible) so existing users see no change after the migration.
--
-- The widgets themselves stay rendered into the layout for everyone;
-- the prefs gate visibility via CSS / x-show, not removal from DOM,
-- so toggling on / off doesn't require a hard refresh.

ALTER TABLE users ADD COLUMN show_todo_widget        INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN show_coming_soon_widget INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN show_postits_widget     INTEGER NOT NULL DEFAULT 1;
