-- =====================================================================
-- Migration 0062 — opportunity-funnel simplification.
--
-- Streamlines the deal-funnel stage catalog before the WFM import:
--   * Removes qualifying / cost_build / internal_review (rarely used,
--     redundant with table-driven artifacts — cost_builds is its own
--     table, BANT lives in dedicated columns, internal review of a
--     quote is governed by quote.status not opportunity.stage)
--   * Renames negotiation → revision (matches actual C-LARS workflow:
--     post-submission iteration is on the quote document, not on terms)
--   * Renames closed_won → won, closed_lost → lost, closed_abandoned →
--     abandoned (cleaner symmetry; the "closed_" prefix was always
--     redundant — is_terminal in stage_definitions already encodes that)
--
-- The has_account_and_contact gate (formerly on internal_review) moves
-- onto `submitted` so the requirement still fires before a quote
-- leaves the building. It stays a hard gate.
--
-- Existing-opportunity migration:
--   qualifying       → rfq_received
--   cost_build       → quote_draft
--   internal_review  → submitted
--   negotiation      → revision
--   closed_won       → won
--   closed_lost      → lost
--   closed_abandoned → abandoned
--
-- audit_events history is intentionally NOT rewritten — old "stage
-- changed to negotiation" entries stay as historical fact. Reports
-- that aggregate by stage_key may show a tail of legacy values for a
-- while; that's fine and accurate.
--
-- The opportunities.stage FK on stage_definitions was already dropped
-- in migration 0028, so this migration just rewrites rows directly
-- without temporary holding states.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Step 1: migrate existing opportunities off renamed/removed stages.
-- ---------------------------------------------------------------------

UPDATE opportunities SET stage = 'rfq_received' WHERE stage = 'qualifying';
UPDATE opportunities SET stage = 'quote_draft'  WHERE stage = 'cost_build';
UPDATE opportunities SET stage = 'submitted'    WHERE stage = 'internal_review';
UPDATE opportunities SET stage = 'revision'     WHERE stage = 'negotiation';
UPDATE opportunities SET stage = 'won'          WHERE stage = 'closed_won';
UPDATE opportunities SET stage = 'lost'         WHERE stage = 'closed_lost';
UPDATE opportunities SET stage = 'abandoned'    WHERE stage = 'closed_abandoned';

-- ---------------------------------------------------------------------
-- Step 2: insert new stage_definitions rows (one set per transaction_type).
-- ---------------------------------------------------------------------

-- ---- spares -----
INSERT INTO stage_definitions (transaction_type, stage_key, label, sort_order, default_probability, is_terminal, is_won, gate_rules_json) VALUES
  ('spares', 'revision',  'Revision (customer feedback / quote amendments)',  80,  80, 0, 0, NULL),
  ('spares', 'won',       'Won (OC issued)',                                 110, 100, 1, 1, '{"requires":[{"check":"has_customer_po","severity":"hard"},{"check":"has_oc_data","severity":"hard"}]}'),
  ('spares', 'lost',      'Lost',                                            900,   0, 1, 0, NULL),
  ('spares', 'abandoned', 'Abandoned',                                       910,   0, 1, 0, NULL);

-- ---- eps -----
INSERT INTO stage_definitions (transaction_type, stage_key, label, sort_order, default_probability, is_terminal, is_won, gate_rules_json) VALUES
  ('eps', 'revision',  'Revision (customer feedback / quote amendments)',     80,  80, 0, 0, NULL),
  ('eps', 'won',       'Won (OC issued; NTP pending authorization)',         110, 100, 1, 1, '{"requires":[{"check":"has_customer_po","severity":"hard"},{"check":"has_oc_data","severity":"hard"}]}'),
  ('eps', 'lost',      'Lost',                                                900,   0, 1, 0, NULL),
  ('eps', 'abandoned', 'Abandoned',                                           910,   0, 1, 0, NULL);

-- ---- refurb -----
INSERT INTO stage_definitions (transaction_type, stage_key, label, sort_order, default_probability, is_terminal, is_won, gate_rules_json) VALUES
  ('refurb', 'revision',  'Revision (baseline scope / quote amendments)',     80,  80, 0, 0, NULL),
  ('refurb', 'won',       'Won (baseline OC issued)',                        110, 100, 1, 1, '{"requires":[{"check":"has_customer_po","severity":"hard"},{"check":"has_oc_data","severity":"hard"}]}'),
  ('refurb', 'lost',      'Lost',                                             900,   0, 1, 0, NULL),
  ('refurb', 'abandoned', 'Abandoned',                                        910,   0, 1, 0, NULL);

-- ---- service -----
INSERT INTO stage_definitions (transaction_type, stage_key, label, sort_order, default_probability, is_terminal, is_won, gate_rules_json) VALUES
  ('service', 'revision',  'Revision (customer feedback / quote amendments)', 80,  80, 0, 0, NULL),
  ('service', 'won',       'Won (OC issued)',                                110, 100, 1, 1, '{"requires":[{"check":"has_customer_po","severity":"hard"},{"check":"has_oc_data","severity":"hard"}]}'),
  ('service', 'lost',      'Lost',                                            900,   0, 1, 0, NULL),
  ('service', 'abandoned', 'Abandoned',                                       910,   0, 1, 0, NULL);

-- ---------------------------------------------------------------------
-- Step 3: move the has_account_and_contact hard gate from the (about-to-
-- be-deleted) internal_review stage onto `submitted`. The previous
-- gates on `submitted` were all soft (valid_until / delivery_terms /
-- payment_terms / governance revisions); we keep those soft and add
-- the new hard one.
-- ---------------------------------------------------------------------

UPDATE stage_definitions
   SET gate_rules_json = '{"requires":[{"check":"has_account_and_contact","severity":"hard"},{"check":"has_valid_until_set","severity":"soft"},{"check":"has_delivery_terms_set","severity":"soft"},{"check":"has_payment_terms_set","severity":"soft"},{"check":"has_governance_revisions_snapshotted","severity":"soft"}]}'
 WHERE stage_key = 'submitted';

-- ---------------------------------------------------------------------
-- Step 4: drop the obsolete stage_definitions rows.
-- ---------------------------------------------------------------------

DELETE FROM stage_definitions
 WHERE stage_key IN (
   'qualifying',
   'cost_build',
   'internal_review',
   'negotiation',
   'closed_won',
   'closed_lost',
   'closed_abandoned'
 );
