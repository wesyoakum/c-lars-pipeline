-- 0057_notify_skip_self.sql
--
-- Phase 7d-2 — "skip my own actions" toggle for external notifications.
--
-- Until now the dispatcher fires for every matching event regardless
-- of who triggered it, which means: change a quote's status, get a
-- notification about it. That's noise. Default behavior should be
-- "tell me when other people do things to my stuff", with an opt-in
-- override for users who actually want to see their own actions
-- echoed (rare; mostly useful for testing).
--
-- One per-user toggle on the users table. Default 0 (= skip self).
-- The dispatcher reads it via notifyExternal()'s actorUserId opt:
-- when actorUserId === userId AND notify_self_actions = 0, the event
-- is skipped (logged with status='skipped', reason='self_action').

ALTER TABLE users ADD COLUMN notify_self_actions INTEGER NOT NULL DEFAULT 0;
