-- =====================================================================
-- Migration 0051: AI Inbox v2 — actions and entity resolution.
--
-- Adds two new tables that bridge AI Inbox items to existing CRM rows
-- (activities, accounts, contacts, opportunities). No existing tables
-- are altered. The bridge points FROM ai_inbox_items TO existing
-- entities only (never the reverse) so the experiment stays revertable
-- by dropping these two tables.
--
-- ai_inbox_links: one row per "action taken" — whether that action
-- created a new row (insert + link) or just associated this item with
-- an existing entity (link only). Generic ref_type/ref_id pair so the
-- same table handles create_task, link_to_account, link_to_opportunity,
-- create_reminder, archive, etc.
--
-- ai_inbox_entity_matches: one row per (item, mention_text, candidate)
-- triple from the entity resolver. user_overridden=1 freezes the row
-- against re-run. auto_resolved=1 means the resolver picked it without
-- a user click (e.g., score 100 with a wide margin to #2).
-- =====================================================================

CREATE TABLE IF NOT EXISTS ai_inbox_links (
  id                  TEXT PRIMARY KEY,
  item_id             TEXT NOT NULL REFERENCES ai_inbox_items(id) ON DELETE CASCADE,

  -- 'create_task' | 'link_to_account' | 'link_to_opportunity'
  -- | 'create_reminder' | 'create_account' | 'create_contact'
  -- | 'archive' (no ref) | future kinds.
  action_type         TEXT NOT NULL,

  -- Target entity. ref_type is one of 'activity' | 'account' | 'contact'
  -- | 'opportunity' | 'quote' | 'job'. NULL for actions with no target
  -- (archive). ref_label is a denormalized display string captured at
  -- link time so the detail page can render even if the target gets
  -- renamed or deleted later.
  ref_type            TEXT,
  ref_id              TEXT,
  ref_label           TEXT,

  created_at          TEXT NOT NULL,
  created_by_user_id  TEXT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_ai_inbox_links_item
  ON ai_inbox_links(item_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_inbox_links_ref
  ON ai_inbox_links(ref_type, ref_id);


CREATE TABLE IF NOT EXISTS ai_inbox_entity_matches (
  id              TEXT PRIMARY KEY,
  item_id         TEXT NOT NULL REFERENCES ai_inbox_items(id) ON DELETE CASCADE,

  -- Mention from extracted_json: 'person' | 'organization'.
  mention_kind    TEXT NOT NULL,
  -- The exact string the LLM produced ("Jane Smith", "Acme Inc.").
  mention_text    TEXT NOT NULL,
  -- Index of this mention within its array (people[0], organizations[2])
  -- so re-runs after edits can match by position when text changes.
  mention_idx     INTEGER NOT NULL DEFAULT 0,

  -- Candidate. ref_type is 'account' for organizations, 'contact' for
  -- persons. ref_id and ref_label denormalized like ai_inbox_links.
  ref_type        TEXT NOT NULL,
  ref_id          TEXT NOT NULL,
  ref_label       TEXT NOT NULL,

  -- 0..200 score from the resolver. rank 1 = best candidate; we keep
  -- top 3 per mention.
  score           INTEGER NOT NULL,
  rank            INTEGER NOT NULL,

  -- 1 when the resolver auto-picked this candidate (clear winner).
  auto_resolved   INTEGER NOT NULL DEFAULT 0,
  -- 1 when the user manually accepted this candidate. user_overridden
  -- rows are NEVER replaced by re-run — they only get cleared when the
  -- user explicitly unmatches.
  user_overridden INTEGER NOT NULL DEFAULT 0,

  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_inbox_matches_item
  ON ai_inbox_entity_matches(item_id, mention_kind, mention_idx, rank);
