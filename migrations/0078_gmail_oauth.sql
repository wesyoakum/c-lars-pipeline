-- =====================================================================
-- Migration 0078 — Gmail OAuth tokens.
--
-- Stores per-user Gmail OAuth tokens for Claudia's read-only Gmail
-- access tools (search_gmail / read_gmail_message / list_gmail_threads).
-- One row per user; PRIMARY KEY on user_id makes the upsert pattern
-- clean.
--
-- Token model: standard Google OAuth.
--   - access_token: short-lived (~1 hour), used as Bearer for API calls.
--   - refresh_token: long-lived (DOES NOT rotate on each use, unlike
--     WFM/BlueRock), used to mint new access tokens.
--   - access_expires_at: ISO timestamp; we refresh proactively when
--     within 60s of expiry.
--
-- Caveat: in Google Cloud "Testing" mode, refresh tokens expire after
-- 7 days. Wes will need to reconnect weekly until the OAuth app is
-- published / verified. The Settings UI shows the connection state
-- so he sees it before Claudia surfaces "tokens expired" mid-chat.
--
-- Scopes granted are stored alongside so the read tools can verify
-- before calling (e.g. require gmail.readonly). Connected_email is
-- the email address Wes authenticated with — usually his personal
-- gmail address, not his work email.
--
-- Reversible: dropping the table just disconnects Gmail. Claudia's
-- read tools return { error: 'gmail_not_connected' } when the row
-- is missing, which she surfaces to Wes plainly.
-- =====================================================================

CREATE TABLE IF NOT EXISTS gmail_oauth_tokens (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  refresh_token      TEXT NOT NULL,
  access_token       TEXT,
  access_expires_at  TEXT,
  scopes             TEXT,
  connected_email    TEXT,
  connected_at       TEXT NOT NULL,
  last_refreshed_at  TEXT,
  last_error         TEXT
);
