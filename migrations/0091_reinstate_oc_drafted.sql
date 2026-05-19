-- 0091_reinstate_oc_drafted.sql
--
-- Partially reverts 0088. Reinstates the `oc_drafted` holding stage for
-- every transaction_type.
--
-- Why: accepting a baseline quote now AUTO-creates the OC job and lands
-- the opportunity in "OC drafted" (instead of the old, never-resolving
-- `closed_won` target — `closed_won` was renamed to `won` back in 0062,
-- so the accept handler's stage move had been a silent no-op). The OC is
-- then issued from /jobs/:id/oc, which advances the opp to `oc_submitted`
-- (sort 120) as before. `oc_drafted` slots between `won` (sort 110) and
-- `oc_submitted` (sort 120).
--
--   accept quote  → oc_drafted (115)            ← reinstated here
--   issue OC      → oc_submitted (120)          ← functions/jobs/[id]/issue-oc.js
--
-- Not reinstated: `amended_oc_drafted` (the refurb supplemental loop is
-- out of scope; its 0088 removal stands).
--
-- is_terminal = 0 (work continues), is_won = 1 (forecast: closed-won),
-- default_probability = 100 (acceptance = certain; matches `won`). No
-- gate — the customer-PO / OC-data requirement is enforced at OC
-- issuance, not on entry to the drafting stage.
--
-- PRIMARY KEY (transaction_type, stage_key) makes INSERT OR REPLACE
-- safe to re-run; re-applying overwrites the same four rows in place.

INSERT OR REPLACE INTO stage_definitions
  (transaction_type, stage_key, label, sort_order, default_probability, is_terminal, is_won, gate_rules_json)
VALUES
  ('spares',  'oc_drafted', 'OC drafted', 115, 100, 0, 1, NULL),
  ('service', 'oc_drafted', 'OC drafted', 115, 100, 0, 1, NULL),
  ('eps',     'oc_drafted', 'OC drafted', 115, 100, 0, 1, NULL),
  ('refurb',  'oc_drafted', 'OC drafted', 115, 100, 0, 1, NULL);
