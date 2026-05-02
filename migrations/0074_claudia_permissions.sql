-- =====================================================================
-- Migration 0074 — Claudia per-tool permissions.
--
-- "Treat her like a new employee, gradually loosen the reins" — every
-- mutation tool Claudia exposes is gated by a row in this table. The
-- toolset she sees is built dynamically per request: only enabled
-- actions are included in the tools array sent to Claude. Disabled
-- tools are invisible to her, so she can't even propose using them.
--
-- The settings page at /settings/claudia (Wes-only) flips these flags.
-- Toggling a flag is itself logged to audit_events under
-- entity_type='claudia_permission'.
--
-- Defaults: every action is seeded with enabled=1 — Wes wanted "give
-- her all the tools" up front, then trim as he discovers problems.
-- Actions that don't have rows yet (e.g., when a new tool ships) get
-- the column DEFAULT 1; safe because the chat is still Wes-only and
-- he sees every write in the audit trail.
--
-- Reversible: dropping the table makes every tool effectively
-- ungated. Code falls back to "if no row, treat as enabled" so the
-- worst-case removal is a regression to the v0.484 behavior.
-- =====================================================================

CREATE TABLE IF NOT EXISTS claudia_permissions (
  action              TEXT PRIMARY KEY,
  enabled             INTEGER NOT NULL DEFAULT 1,
  category            TEXT,                   -- e.g. 'contacts', 'accounts', 'activities'
  label               TEXT,                   -- short human label for the settings page
  description         TEXT,                   -- one-line explanation
  updated_at          TEXT NOT NULL,
  updated_by_user_id  TEXT REFERENCES users(id)
);

-- Seed: existing tools that already shipped before this migration.
-- All enabled by default. Future migrations / app code add new rows
-- as new tools come online.
INSERT OR IGNORE INTO claudia_permissions
  (action, enabled, category, label, description, updated_at)
VALUES
  ('create_contact',  1, 'contacts', 'Create contacts',
   'Add new contacts under existing accounts.',
   strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('update_contact',  1, 'contacts', 'Update contacts',
   'Edit contact fields (name, email, phone, title, etc.).',
   strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('create_account',  1, 'accounts', 'Create accounts',
   'Add new accounts (companies / customers).',
   strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('update_account',  1, 'accounts', 'Update accounts',
   'Edit account fields (name, alias, segment, parent group, address, etc.).',
   strftime('%Y-%m-%dT%H:%M:%fZ','now'));
