-- =====================================================================
-- Migration 0041: Stage catalog v2
--
-- Per-type catalog changes (supersedes 0003 stage rows):
--
-- 1. Unified `completed` terminal for all four transaction_types.
--    Replaces the old type-specific terminals (`oc_issued` for
--    spares/service, `ntp_issued` for EPS). Refurb also ends at
--    `completed`.
--
-- 2. Quote-style drafted/submitted pattern for every customer-facing
--    document:
--      • OC:           oc_drafted       → oc_submitted      (both intermediate)
--      • NTP (EPS):    ntp_drafted      → ntp_submitted     (both intermediate)
--      • Supplemental: supplemental_quote_drafted → …_submitted (+ revision pair)
--      • Amended OC:   amended_oc_drafted → amended_oc_submitted
--    No more `_issued` stage — issuing is an event, not a stage.
--
-- 3. Refurb gets the full supplemental loop (stages 11–18):
--      inspection_report_submitted → supplemental_quote_drafted →
--      supplemental_quote_submitted → …under_revision →
--      revised_supplemental_quote_submitted → supplemental_won →
--      amended_oc_drafted → amended_oc_submitted → completed
--    All intermediate, is_won=1.
--
-- 4. New column `opportunities.supplemental_quote` (tri-state nullable).
--    Only meaningful for refurb; UI uses it to collapse the supplemental
--    stages out of the picker when the user has indicated no supplemental
--    is expected.
--      NULL = not decided
--         1 = supplemental quote expected
--         0 = no supplemental quote needed
--
-- 5. Existing opps remapped:
--      spares/service/refurb oc_issued → completed
--      eps   ntp_issued                → completed
--      eps   oc_issued                 → oc_submitted
--      eps   ntp_draft                 → ntp_drafted
--
-- FK to stage_definitions was dropped in 0028 so remap order doesn't
-- matter; we still INSERT new rows first and DELETE stale rows last
-- to keep the catalog valid at every step.
-- =====================================================================


-- ---------------------------------------------------------------------
-- (a) New catalogs
-- ---------------------------------------------------------------------

-- Spares
INSERT OR REPLACE INTO stage_definitions
  (transaction_type, stage_key, label, sort_order, default_probability, is_terminal, is_won, gate_rules_json)
VALUES
  ('spares', 'lead',                     'Lead',                       10,   5, 0, 0, NULL),
  ('spares', 'rfq_received',             'RFQ received',               20,  10, 0, 0, NULL),
  ('spares', 'awaiting_client_feedback', 'Awaiting client feedback',   30,  20, 0, 0, NULL),
  ('spares', 'quote_drafted',            'Quote drafted',              40,  40, 0, 0, NULL),
  ('spares', 'quote_submitted',          'Quote submitted',            50,  60, 0, 0, NULL),
  ('spares', 'quote_under_revision',     'Quote under revision',       60,  65, 0, 0, NULL),
  ('spares', 'revised_quote_submitted',  'Revised quote submitted',    70,  75, 0, 0, NULL),
  ('spares', 'closed_won',               'Won',                       100,  95, 0, 1, NULL),
  ('spares', 'oc_drafted',               'OC drafted',                110,  97, 0, 1, NULL),
  ('spares', 'oc_submitted',             'OC submitted',              120,  99, 0, 1, NULL),
  ('spares', 'completed',                'Completed',                 130, 100, 1, 1, NULL),
  ('spares', 'closed_lost',              'Closed — lost',             900,   0, 1, 0, NULL),
  ('spares', 'closed_died',              'Closed — died',             910,   0, 1, 0, NULL);

-- Service (identical shape)
INSERT OR REPLACE INTO stage_definitions
  (transaction_type, stage_key, label, sort_order, default_probability, is_terminal, is_won, gate_rules_json)
VALUES
  ('service', 'lead',                     'Lead',                       10,   5, 0, 0, NULL),
  ('service', 'rfq_received',             'RFQ received',               20,  10, 0, 0, NULL),
  ('service', 'awaiting_client_feedback', 'Awaiting client feedback',   30,  20, 0, 0, NULL),
  ('service', 'quote_drafted',            'Quote drafted',              40,  40, 0, 0, NULL),
  ('service', 'quote_submitted',          'Quote submitted',            50,  60, 0, 0, NULL),
  ('service', 'quote_under_revision',     'Quote under revision',       60,  65, 0, 0, NULL),
  ('service', 'revised_quote_submitted',  'Revised quote submitted',    70,  75, 0, 0, NULL),
  ('service', 'closed_won',               'Won',                       100,  95, 0, 1, NULL),
  ('service', 'oc_drafted',               'OC drafted',                110,  97, 0, 1, NULL),
  ('service', 'oc_submitted',             'OC submitted',              120,  99, 0, 1, NULL),
  ('service', 'completed',                'Completed',                 130, 100, 1, 1, NULL),
  ('service', 'closed_lost',              'Closed — lost',             900,   0, 1, 0, NULL),
  ('service', 'closed_died',              'Closed — died',             910,   0, 1, 0, NULL);

-- EPS (adds NTP between OC and completed)
INSERT OR REPLACE INTO stage_definitions
  (transaction_type, stage_key, label, sort_order, default_probability, is_terminal, is_won, gate_rules_json)
VALUES
  ('eps', 'lead',                     'Lead',                       10,   5, 0, 0, NULL),
  ('eps', 'rfq_received',             'RFQ received',               20,  10, 0, 0, NULL),
  ('eps', 'awaiting_client_feedback', 'Awaiting client feedback',   30,  20, 0, 0, NULL),
  ('eps', 'quote_drafted',            'Quote drafted',              40,  40, 0, 0, NULL),
  ('eps', 'quote_submitted',          'Quote submitted',            50,  60, 0, 0, NULL),
  ('eps', 'quote_under_revision',     'Quote under revision',       60,  65, 0, 0, NULL),
  ('eps', 'revised_quote_submitted',  'Revised quote submitted',    70,  75, 0, 0, NULL),
  ('eps', 'closed_won',               'Won',                       100,  95, 0, 1, NULL),
  ('eps', 'oc_drafted',               'OC drafted',                110,  96, 0, 1, NULL),
  ('eps', 'oc_submitted',             'OC submitted',              120,  97, 0, 1, NULL),
  ('eps', 'ntp_drafted',              'NTP drafted',               130,  98, 0, 1, NULL),
  ('eps', 'ntp_submitted',            'NTP submitted',             140,  99, 0, 1, NULL),
  ('eps', 'completed',                'Completed',                 150, 100, 1, 1, NULL),
  ('eps', 'closed_lost',              'Closed — lost',             900,   0, 1, 0, NULL),
  ('eps', 'closed_died',              'Closed — died',             910,   0, 1, 0, NULL);

-- Refurb (adds inspection report + supplemental quote loop + amended OC)
INSERT OR REPLACE INTO stage_definitions
  (transaction_type, stage_key, label, sort_order, default_probability, is_terminal, is_won, gate_rules_json)
VALUES
  ('refurb', 'lead',                                 'Lead',                                 10,    5, 0, 0, NULL),
  ('refurb', 'rfq_received',                         'RFQ received',                         20,   10, 0, 0, NULL),
  ('refurb', 'awaiting_client_feedback',             'Awaiting client feedback',             30,   20, 0, 0, NULL),
  ('refurb', 'quote_drafted',                        'Quote drafted',                        40,   40, 0, 0, NULL),
  ('refurb', 'quote_submitted',                      'Quote submitted',                      50,   60, 0, 0, NULL),
  ('refurb', 'quote_under_revision',                 'Quote under revision',                 60,   65, 0, 0, NULL),
  ('refurb', 'revised_quote_submitted',              'Revised quote submitted',              70,   75, 0, 0, NULL),
  ('refurb', 'closed_won',                           'Won',                                 100,   90, 0, 1, NULL),
  ('refurb', 'oc_drafted',                           'OC drafted',                          110,   92, 0, 1, NULL),
  ('refurb', 'oc_submitted',                         'OC submitted',                        120,   93, 0, 1, NULL),
  ('refurb', 'inspection_report_submitted',          'Inspection Report submitted',         130,   95, 0, 1, NULL),
  ('refurb', 'supplemental_quote_drafted',           'Supplemental quote drafted',          140,   96, 0, 1, NULL),
  ('refurb', 'supplemental_quote_submitted',         'Supplemental quote submitted',        150,   97, 0, 1, NULL),
  ('refurb', 'supplemental_quote_under_revision',    'Supplemental quote under revision',   160,   97, 0, 1, NULL),
  ('refurb', 'revised_supplemental_quote_submitted', 'Revised supplemental quote submitted',170,   98, 0, 1, NULL),
  ('refurb', 'supplemental_won',                     'Supplemental won',                    180,   98, 0, 1, NULL),
  ('refurb', 'amended_oc_drafted',                   'Amended OC drafted',                  190,   99, 0, 1, NULL),
  ('refurb', 'amended_oc_submitted',                 'Amended OC submitted',                200,   99, 0, 1, NULL),
  ('refurb', 'completed',                            'Completed',                           210,  100, 1, 1, NULL),
  ('refurb', 'closed_lost',                          'Closed — lost',                       900,    0, 1, 0, NULL),
  ('refurb', 'closed_died',                          'Closed — died',                       910,    0, 1, 0, NULL);


-- ---------------------------------------------------------------------
-- (b) Remap existing opportunities to the new catalog.
-- ---------------------------------------------------------------------

-- Spares / Service / Refurb — old terminal `oc_issued` folds into the new
-- unified terminal `completed`.
UPDATE opportunities
   SET stage = 'completed'
 WHERE transaction_type IN ('spares', 'service', 'refurb')
   AND stage = 'oc_issued';

-- EPS — old intermediate `oc_issued` maps to new `oc_submitted`
-- (no "issued" stage anymore; user finished the OC).
UPDATE opportunities
   SET stage = 'oc_submitted'
 WHERE transaction_type = 'eps'
   AND stage = 'oc_issued';

-- EPS — `ntp_draft` renamed to `ntp_drafted` for naming consistency.
UPDATE opportunities
   SET stage = 'ntp_drafted'
 WHERE transaction_type = 'eps'
   AND stage = 'ntp_draft';

-- EPS — old terminal `ntp_issued` folds into `completed`.
UPDATE opportunities
   SET stage = 'completed'
 WHERE transaction_type = 'eps'
   AND stage = 'ntp_issued';


-- ---------------------------------------------------------------------
-- (c) Drop stage_definitions rows that no longer exist in the new
-- catalog. Run AFTER the opportunity remap so we never point at a key
-- that isn't in the catalog mid-migration.
-- ---------------------------------------------------------------------

DELETE FROM stage_definitions
 WHERE (transaction_type IN ('spares', 'service', 'refurb') AND stage_key = 'oc_issued')
    OR (transaction_type = 'eps' AND stage_key IN ('oc_issued', 'ntp_draft', 'ntp_issued'));


-- ---------------------------------------------------------------------
-- (d) opportunities.supplemental_quote — refurb-only UX flag.
-- ---------------------------------------------------------------------

ALTER TABLE opportunities
  ADD COLUMN supplemental_quote INTEGER;
