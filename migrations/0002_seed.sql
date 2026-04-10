-- =====================================================================
-- C-LARS PMS — Migration 0002 — seed data
--
-- Seeds the stage catalog (one set of shared early stages per
-- transaction_type, converging at closed_won on OC/NTP issuance),
-- the governing document register (four controlled docs at Rev A),
-- numbering counters, and the initial admin user.
-- =====================================================================


-- ---------------------------------------------------------------------
-- Stage definitions
--
-- All four transaction types share the same 11-stage "shared early path"
-- plus three terminal stages. Gate rules are stored as JSON so they can
-- be tuned without a code deploy. Severity: 'soft' = overridable with
-- a reason written to audit_events.override_reason; 'hard' = blocks.
--
-- 'gate_rules_json' uses this DSL (see functions/lib/stages.js):
--   { "requires": [ { "check": "<name>", "severity": "soft"|"hard" }, ... ] }
--
-- Initial gate placements (conservative, tunable later):
--   cost_build      → quote_draft        : has_cost_build                     (soft)
--   quote_draft     → internal_review    : has_account_and_contact            (hard)
--   internal_review → submitted          : has_valid_until_set,
--                                          has_delivery_terms_set,
--                                          has_payment_terms_set,
--                                          has_governance_revisions_snapshotted (all soft)
--   po_received     → closed_won         : has_customer_po (hard),
--                                          has_oc_data (hard)
-- ---------------------------------------------------------------------

-- Helper pattern: the same 11 non-terminal rows are inserted for each
-- transaction_type. SQLite doesn't support parameterized inserts inside
-- migrations the way PostgreSQL does, so we just write the rows out.

-- ---- SPARES ---------------------------------------------------------

INSERT INTO stage_definitions (transaction_type, stage_key, label, sort_order, default_probability, is_terminal, is_won, gate_rules_json) VALUES
  ('spares', 'lead',            'Lead created',                                 10,   5, 0, 0, NULL),
  ('spares', 'rfq_received',    'RFQ received',                                 20,  10, 0, 0, NULL),
  ('spares', 'qualifying',      'Qualifying (BANT-lite)',                       30,  20, 0, 0, NULL),
  ('spares', 'cost_build',      'Cost build (internal)',                        40,  35, 0, 0, NULL),
  ('spares', 'quote_draft',     'Quote draft',                                  50,  50, 0, 0, '{"requires":[{"check":"has_cost_build","severity":"soft"}]}'),
  ('spares', 'internal_review', 'Internal review (scope / pricing / delivery)', 60,  60, 0, 0, '{"requires":[{"check":"has_account_and_contact","severity":"hard"}]}'),
  ('spares', 'submitted',       'Submitted to customer',                        70,  70, 0, 0, '{"requires":[{"check":"has_valid_until_set","severity":"soft"},{"check":"has_delivery_terms_set","severity":"soft"},{"check":"has_payment_terms_set","severity":"soft"},{"check":"has_governance_revisions_snapshotted","severity":"soft"}]}'),
  ('spares', 'negotiation',     'Negotiation',                                  80,  80, 0, 0, NULL),
  ('spares', 'verbal_win',      'Verbal win',                                   90,  90, 0, 0, NULL),
  ('spares', 'po_received',     'Customer PO received',                        100,  95, 0, 0, NULL),
  ('spares', 'closed_won',      'Closed — won (OC issued)',                    110, 100, 1, 1, '{"requires":[{"check":"has_customer_po","severity":"hard"},{"check":"has_oc_data","severity":"hard"}]}'),
  ('spares', 'closed_lost',     'Closed — lost',                               900,   0, 1, 0, NULL),
  ('spares', 'closed_abandoned','Closed — abandoned',                          910,   0, 1, 0, NULL);

-- ---- EPS ------------------------------------------------------------

INSERT INTO stage_definitions (transaction_type, stage_key, label, sort_order, default_probability, is_terminal, is_won, gate_rules_json) VALUES
  ('eps', 'lead',            'Lead created',                                    10,   5, 0, 0, NULL),
  ('eps', 'rfq_received',    'RFQ received',                                    20,  10, 0, 0, NULL),
  ('eps', 'qualifying',      'Qualifying (BANT-lite)',                          30,  20, 0, 0, NULL),
  ('eps', 'cost_build',      'Cost build (internal)',                           40,  35, 0, 0, NULL),
  ('eps', 'quote_draft',     'Quote draft',                                     50,  50, 0, 0, '{"requires":[{"check":"has_cost_build","severity":"soft"}]}'),
  ('eps', 'internal_review', 'Internal review (scope / pricing / delivery)',    60,  60, 0, 0, '{"requires":[{"check":"has_account_and_contact","severity":"hard"}]}'),
  ('eps', 'submitted',       'Submitted to customer',                           70,  70, 0, 0, '{"requires":[{"check":"has_valid_until_set","severity":"soft"},{"check":"has_delivery_terms_set","severity":"soft"},{"check":"has_payment_terms_set","severity":"soft"},{"check":"has_governance_revisions_snapshotted","severity":"soft"}]}'),
  ('eps', 'negotiation',     'Negotiation',                                     80,  80, 0, 0, NULL),
  ('eps', 'verbal_win',      'Verbal win',                                      90,  90, 0, 0, NULL),
  ('eps', 'po_received',     'Customer PO received',                           100,  95, 0, 0, NULL),
  ('eps', 'closed_won',      'Closed — won (OC issued; NTP pending authorization)', 110, 100, 1, 1, '{"requires":[{"check":"has_customer_po","severity":"hard"},{"check":"has_oc_data","severity":"hard"}]}'),
  ('eps', 'closed_lost',     'Closed — lost',                                  900,   0, 1, 0, NULL),
  ('eps', 'closed_abandoned','Closed — abandoned',                             910,   0, 1, 0, NULL);

-- ---- REFURB ---------------------------------------------------------

INSERT INTO stage_definitions (transaction_type, stage_key, label, sort_order, default_probability, is_terminal, is_won, gate_rules_json) VALUES
  ('refurb', 'lead',            'Lead created',                                 10,   5, 0, 0, NULL),
  ('refurb', 'rfq_received',    'RFQ received',                                 20,  10, 0, 0, NULL),
  ('refurb', 'qualifying',      'Qualifying (BANT-lite)',                       30,  20, 0, 0, NULL),
  ('refurb', 'cost_build',      'Cost build (baseline scope)',                  40,  35, 0, 0, NULL),
  ('refurb', 'quote_draft',     'Baseline quote draft',                         50,  50, 0, 0, '{"requires":[{"check":"has_cost_build","severity":"soft"}]}'),
  ('refurb', 'internal_review', 'Internal review (scope / pricing / delivery)', 60,  60, 0, 0, '{"requires":[{"check":"has_account_and_contact","severity":"hard"}]}'),
  ('refurb', 'submitted',       'Baseline quote submitted',                     70,  70, 0, 0, '{"requires":[{"check":"has_valid_until_set","severity":"soft"},{"check":"has_delivery_terms_set","severity":"soft"},{"check":"has_payment_terms_set","severity":"soft"},{"check":"has_governance_revisions_snapshotted","severity":"soft"}]}'),
  ('refurb', 'negotiation',     'Negotiation',                                  80,  80, 0, 0, NULL),
  ('refurb', 'verbal_win',      'Verbal win',                                   90,  90, 0, 0, NULL),
  ('refurb', 'po_received',     'Customer PO received',                        100,  95, 0, 0, NULL),
  ('refurb', 'closed_won',      'Closed — won (baseline OC issued)',           110, 100, 1, 1, '{"requires":[{"check":"has_customer_po","severity":"hard"},{"check":"has_oc_data","severity":"hard"}]}'),
  ('refurb', 'closed_lost',     'Closed — lost',                               900,   0, 1, 0, NULL),
  ('refurb', 'closed_abandoned','Closed — abandoned',                          910,   0, 1, 0, NULL);

-- ---- SERVICE --------------------------------------------------------

INSERT INTO stage_definitions (transaction_type, stage_key, label, sort_order, default_probability, is_terminal, is_won, gate_rules_json) VALUES
  ('service', 'lead',            'Lead created',                                 10,   5, 0, 0, NULL),
  ('service', 'rfq_received',    'RFQ received',                                 20,  10, 0, 0, NULL),
  ('service', 'qualifying',      'Qualifying (BANT-lite)',                       30,  20, 0, 0, NULL),
  ('service', 'cost_build',      'Cost build (internal)',                        40,  35, 0, 0, NULL),
  ('service', 'quote_draft',     'Quote draft',                                  50,  50, 0, 0, '{"requires":[{"check":"has_cost_build","severity":"soft"}]}'),
  ('service', 'internal_review', 'Internal review (scope / pricing / delivery)', 60,  60, 0, 0, '{"requires":[{"check":"has_account_and_contact","severity":"hard"}]}'),
  ('service', 'submitted',       'Submitted to customer',                        70,  70, 0, 0, '{"requires":[{"check":"has_valid_until_set","severity":"soft"},{"check":"has_delivery_terms_set","severity":"soft"},{"check":"has_payment_terms_set","severity":"soft"},{"check":"has_governance_revisions_snapshotted","severity":"soft"}]}'),
  ('service', 'negotiation',     'Negotiation',                                  80,  80, 0, 0, NULL),
  ('service', 'verbal_win',      'Verbal win',                                   90,  90, 0, 0, NULL),
  ('service', 'po_received',     'Customer PO received',                        100,  95, 0, 0, NULL),
  ('service', 'closed_won',      'Closed — won (OC issued)',                    110, 100, 1, 1, '{"requires":[{"check":"has_customer_po","severity":"hard"},{"check":"has_oc_data","severity":"hard"}]}'),
  ('service', 'closed_lost',     'Closed — lost',                               900,   0, 1, 0, NULL),
  ('service', 'closed_abandoned','Closed — abandoned',                          910,   0, 1, 0, NULL);


-- ---------------------------------------------------------------------
-- Governing document register (C-LARS Document Control Register Rev A)
-- Seed IDs are deterministic so they can be referenced by code.
-- ---------------------------------------------------------------------

INSERT INTO governing_documents (id, doc_key, revision, effective_date, title, status, notes) VALUES
  ('gov-terms-a',         'terms',         'A', '2026-01-01', 'C-LARS General Terms and Conditions of Sale and Services', 'active', 'Highest precedence unless expressly stated otherwise'),
  ('gov-warranty-a',      'warranty',      'A', '2026-01-01', 'C-LARS Limited Warranty Policy',                           'active', 'Applies to new equipment and applicable services'),
  ('gov-refurb-sop-a',    'refurb_sop',    'A', '2026-01-01', 'C-LARS Refurbishment Standard Operating Procedure',         'active', 'Applies to refurbishment of buyer-supplied equipment'),
  ('gov-rate-schedule-a', 'rate_schedule', 'A', '2026-01-01', 'C-LARS Field Service Day Rate Schedule',                   'active', 'Applies to non-warranty field service and commissioning');


-- ---------------------------------------------------------------------
-- Numbering counters
-- ---------------------------------------------------------------------

INSERT INTO sequences (scope, next_value) VALUES
  ('OPP-2026', 1),
  ('Q-2026',   1),
  ('JOB-2026', 1);


-- ---------------------------------------------------------------------
-- Initial admin user
--
-- The real identity comes from Cloudflare Access (Google/Microsoft SSO).
-- On first login, middleware upserts a row keyed on the Access email
-- claim. This seed row ensures `wes.yoakum@c-lars.com` already has
-- 'admin' role so the first login lands as admin instead of defaulting
-- to 'sales'. The INSERT OR IGNORE is safe if the row already exists.
-- ---------------------------------------------------------------------

INSERT OR IGNORE INTO users (id, email, display_name, role, active) VALUES
  ('user-wes-yoakum', 'wes.yoakum@c-lars.com', 'Wes Yoakum', 'admin', 1);
