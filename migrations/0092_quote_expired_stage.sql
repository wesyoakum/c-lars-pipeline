-- 0092_quote_expired_stage.sql
--
-- New opportunity stage `quote_expired` — "we sent a quote, customer
-- didn't act before valid_until, deal is stalled (not dead)". Sits in
-- the quote-cycle range between `revised_quote_submitted` (70) and
-- `won` (110) at sort_order 80.
--
-- is_terminal = 0 (revivable via a revision / new quote)
-- is_won     = 0 (no acceptance)
-- default_probability = 25 (low confidence, but not closed-lost)
--
-- Re-applying: INSERT OR REPLACE rewrites the same four rows in place.
-- The UPDATE is bounded by "not already at quote_expired" so a re-run
-- doesn't re-stamp updated_at unnecessarily; it WILL pick up any new
-- applicable opps that drifted in since the first apply.
--
-- "Applicable opp" = pre-won (lead / rfq_received / quote_drafted /
-- quote_submitted / quote_under_revision / revised_quote_submitted)
-- AND has at least one expired quote AND has NO still-alive quote
-- (draft / issued / revision_draft / revision_issued / accepted). The
-- last clause is what prevents an opp that expired a quote then
-- revised / re-issued / had an acceptance landing from being yanked
-- backward into `quote_expired`.

INSERT OR REPLACE INTO stage_definitions
  (transaction_type, stage_key, label, sort_order, default_probability, is_terminal, is_won, gate_rules_json)
VALUES
  ('spares',  'quote_expired', 'Quote Expired', 80, 25, 0, 0, NULL),
  ('service', 'quote_expired', 'Quote Expired', 80, 25, 0, 0, NULL),
  ('eps',     'quote_expired', 'Quote Expired', 80, 25, 0, 0, NULL),
  ('refurb',  'quote_expired', 'Quote Expired', 80, 25, 0, 0, NULL);

UPDATE opportunities
   SET stage = 'quote_expired',
       stage_entered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       probability = 25,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE stage IN (
   'lead',
   'rfq_received',
   'quote_drafted',
   'quote_submitted',
   'quote_under_revision',
   'revised_quote_submitted'
 )
   AND stage != 'quote_expired'
   AND EXISTS (
     SELECT 1 FROM quotes q
      WHERE q.opportunity_id = opportunities.id
        AND q.status = 'expired'
   )
   AND NOT EXISTS (
     SELECT 1 FROM quotes q
      WHERE q.opportunity_id = opportunities.id
        AND q.status IN ('draft','issued','revision_draft','revision_issued','accepted')
   );
