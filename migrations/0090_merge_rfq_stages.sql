-- 0090_merge_rfq_stages.sql
--
-- Consolidate the two early-funnel stages "RFQ received" and
-- "Awaiting client feedback" into a single stage labeled "RFQ".
--
-- Survivor: stage_key 'rfq_received' (relabeled "RFQ"). Opps parked in
-- 'awaiting_client_feedback' move back to 'rfq_received'; the
-- awaiting_client_feedback catalog rows are then dropped for every
-- transaction_type. Idempotent: re-running matches 0 rows.

UPDATE opportunities
   SET stage = 'rfq_received',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE stage = 'awaiting_client_feedback';

UPDATE stage_definitions
   SET label = 'RFQ'
 WHERE stage_key = 'rfq_received';

DELETE FROM stage_definitions
 WHERE stage_key = 'awaiting_client_feedback';
