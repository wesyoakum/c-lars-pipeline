-- 0031_board_cards.sql
--
-- Whiteboard / fridge-door sidebar.
--
-- A right-side sidebar that surfaces "sticky note" cards across four
-- modules:
--   * My Tasks       — read-only, derived from the existing activities table
--   * My Notes       — scope='private', author only
--   * Shared Board   — scope='public', everyone
--   * Mentions       — scope='direct' to me, or scope='public' with an
--                      @-mention of me
--
-- Design notes:
--   * One table for all card types (rather than separate notes / reminders
--     / announcements tables). Modules are filtered views of board_cards.
--   * body stores plain text with embedded @[<type>:<id>|<display>]
--     markers. On save, the server parses those markers and writes one
--     row per reference to board_card_refs. That gives us cheap reverse
--     queries ("which cards mention opportunity X?").
--   * board_user_prefs holds per-user sidebar state: module order,
--     collapsed state per module, and hidden_until (when the sidebar
--     should auto-expand from collapsed-to-strip).

CREATE TABLE IF NOT EXISTS board_cards (
  id              TEXT PRIMARY KEY,
  author_user_id  TEXT NOT NULL,
  scope           TEXT NOT NULL CHECK (scope IN ('private','public','direct')),
  target_user_id  TEXT,                         -- required iff scope='direct'
  body            TEXT NOT NULL,
  color           TEXT NOT NULL DEFAULT 'yellow'
                  CHECK (color IN ('yellow','pink','blue','green','orange','white')),
  flag            TEXT CHECK (flag IN ('red','yellow','green')),
  pinned          INTEGER NOT NULL DEFAULT 0,
  snooze_until    TEXT,                         -- card hidden from its module until this time
  archived_at     TEXT,                         -- soft delete
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  FOREIGN KEY (author_user_id) REFERENCES users(id),
  FOREIGN KEY (target_user_id) REFERENCES users(id)
);

-- "My private notes" query: author + not-archived, private only.
CREATE INDEX IF NOT EXISTS idx_board_cards_private_author
  ON board_cards(author_user_id, archived_at)
  WHERE scope = 'private';

-- "Shared board" query: public, not-archived, newest first.
CREATE INDEX IF NOT EXISTS idx_board_cards_public
  ON board_cards(archived_at, created_at DESC)
  WHERE scope = 'public';

-- "Mentions via direct scope" query: direct notes addressed to me.
CREATE INDEX IF NOT EXISTS idx_board_cards_direct_target
  ON board_cards(target_user_id, archived_at)
  WHERE scope = 'direct';


-- Cross-references parsed out of a card body on save. One row per
-- (card, ref_type, ref_id) pick from the @-autocomplete. ref_type
-- tells us which table ref_id points at.
CREATE TABLE IF NOT EXISTS board_card_refs (
  card_id   TEXT NOT NULL,
  ref_type  TEXT NOT NULL
             CHECK (ref_type IN ('user','opportunity','quote','account','document')),
  ref_id    TEXT NOT NULL,
  PRIMARY KEY (card_id, ref_type, ref_id),
  FOREIGN KEY (card_id) REFERENCES board_cards(id) ON DELETE CASCADE
);

-- Reverse lookup: "which cards mention this entity?" — used for
-- surfacing a user's mentions module, and (future) surfacing cards
-- that reference an opp/quote/account on that entity's page.
CREATE INDEX IF NOT EXISTS idx_board_card_refs_reverse
  ON board_card_refs(ref_type, ref_id);


-- Per-user sidebar preferences. Single row per user; JSON blobs are
-- always read+written whole (we never query into them), so we don't
-- need to split them into child tables.
CREATE TABLE IF NOT EXISTS board_user_prefs (
  user_id          TEXT PRIMARY KEY,
  module_order     TEXT NOT NULL,    -- JSON array, e.g. ["my_tasks","my_notes","shared","mentions"]
  module_collapsed TEXT NOT NULL,    -- JSON object, e.g. {"my_tasks":false,"my_notes":false,...}
  hidden_until     TEXT,             -- ISO-8601; sidebar auto-expands from collapsed strip after this
  updated_at       TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
