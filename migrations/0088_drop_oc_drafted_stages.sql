-- 0088_drop_oc_drafted_stages.sql
--
-- "OC drafted" and "Amended OC drafted" were holding stages meaning
-- "document generated, not yet sent to the customer". They're redundant:
-- issuing the (amended) OC now moves the opp straight to the matching
-- *_submitted stage, and the auto-created "Submit … to customer" task
-- stays on purely as a non-advancing reminder.
--   - functions/jobs/[id]/issue-oc.js                       → oc_submitted
-- - functions/jobs/[id]/change-orders/[coId]/issue-amended-oc.js → amended_oc_submitted
--   - functions/lib/stage-transitions.js  (submit-OC / submit-amended-OC
--     rule→stage map entries removed, so completing those tasks no
--     longer advances the stage)
--
-- Remap any opp currently parked in a drafted stage FORWARD to the
-- matching submitted stage (must run before the DELETE so no opp.stage
-- references a missing catalog row), then drop the catalog rows for
-- every transaction_type. Re-running this migration matches 0 rows once
-- applied (safe to re-apply).

UPDATE opportunities
   SET stage = 'oc_submitted',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE stage = 'oc_drafted';

UPDATE opportunities
   SET stage = 'amended_oc_submitted',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE stage = 'amended_oc_drafted';

DELETE FROM stage_definitions
 WHERE stage_key IN ('oc_drafted', 'amended_oc_drafted');
