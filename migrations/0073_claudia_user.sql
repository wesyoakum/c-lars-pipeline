-- =====================================================================
-- Migration 0073 — Claudia as a real Pipeline user.
--
-- Up to now Claudia's writes were attributed to whichever human
-- triggered them (Wes), with " (via Claudia)" suffixed in audit
-- summaries. Inserting her as a proper user lets every history view
-- and user picker render her name cleanly, and lays groundwork for
-- assigning tasks to her down the line.
--
-- Synthetic email: claudia@c-lars.com — there is no real inbox; the
-- auth middleware (functions/lib/auth.js) explicitly REJECTS any
-- incoming Cloudflare Access request that uses this email so it
-- cannot be impersonated as a login.
--
-- Role: 'ai'. Lowest rank in functions/lib/auth.js — has no special
-- permissions and won't satisfy hasRole() checks for viewer / sales
-- / admin. Pipeline writes happen via her code path
-- (functions/lib/claudia-writes.js + tools.js), not via the human
-- handlers, so the role gates are bypassed by design.
--
-- Stable id 'claudia-ai' so code can look her up without a query.
-- Reversible: DELETE FROM users WHERE id='claudia-ai' (after first
-- nulling out any FKs that point at her — currently none).
-- =====================================================================

INSERT OR IGNORE INTO users (
  id, email, display_name, role, active,
  show_alias, group_rollup, active_only, list_table_prefs,
  created_at, updated_at
)
VALUES (
  'claudia-ai',
  'claudia@c-lars.com',
  'Claudia',
  'ai',
  1,
  0, 0, 0, NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
);
