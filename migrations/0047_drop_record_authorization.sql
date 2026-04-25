-- =====================================================================
-- Migration 0047: Drop the "Record Authorization" step.
--
-- The authorization handshake between OC issuance and NTP issuance
-- (status='awaiting_authorization') is being removed — EPS jobs now
-- flow OC issued → awaiting_ntp directly, and the NTP page is the
-- next user-facing step.
--
-- Any in-flight jobs sitting at awaiting_authorization get bumped
-- forward to awaiting_ntp so they don't strand on a dead status.
-- The schema columns (authorization_received_at, authorization_notes,
-- ceo_concurrence_*, cfo_concurrence_*) are left in place for
-- historical reads — they're cheap to keep and SQLite drop-column is
-- awkward.
-- =====================================================================

UPDATE jobs
   SET status = 'awaiting_ntp',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE status = 'awaiting_authorization';
