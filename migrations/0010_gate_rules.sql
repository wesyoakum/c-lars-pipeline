-- 0010_gate_rules.sql
--
-- Populate gate_rules_json on the current stage definitions.
-- Migration 0003 replaced the original stages (which had rules) with new
-- stage keys but left gate_rules_json as NULL. This restores gate checks
-- mapped to the current stage keys.
--
-- All severities are 'soft' for now (warn-only mode). The code in
-- lib/stages.js also has GATE_MODE = 'warn' as a safety net.
-- When ready to enforce, change severity to 'hard' here and flip GATE_MODE.

-- quote_drafted: should have a cost build before drafting a quote
UPDATE stage_definitions
   SET gate_rules_json = '{"requires":[{"check":"has_cost_build","severity":"soft"}]}'
 WHERE stage_key = 'quote_drafted';

-- quote_submitted: should have account+contact, valid_until, delivery/payment terms, governance snapshot
UPDATE stage_definitions
   SET gate_rules_json = '{"requires":[{"check":"has_account_and_contact","severity":"soft"},{"check":"has_valid_until_set","severity":"soft"},{"check":"has_delivery_terms_set","severity":"soft"},{"check":"has_payment_terms_set","severity":"soft"},{"check":"has_governance_revisions_snapshotted","severity":"soft"}]}'
 WHERE stage_key = 'quote_submitted';

-- revised_quote_submitted: same checks as quote_submitted
UPDATE stage_definitions
   SET gate_rules_json = '{"requires":[{"check":"has_account_and_contact","severity":"soft"},{"check":"has_valid_until_set","severity":"soft"},{"check":"has_delivery_terms_set","severity":"soft"},{"check":"has_payment_terms_set","severity":"soft"},{"check":"has_governance_revisions_snapshotted","severity":"soft"}]}'
 WHERE stage_key = 'revised_quote_submitted';

-- closed_won: should have customer PO uploaded
UPDATE stage_definitions
   SET gate_rules_json = '{"requires":[{"check":"has_customer_po","severity":"soft"},{"check":"has_account_and_contact","severity":"soft"}]}'
 WHERE stage_key = 'closed_won';

-- oc_issued: should have accepted quote (OC data ready)
UPDATE stage_definitions
   SET gate_rules_json = '{"requires":[{"check":"has_oc_data","severity":"soft"},{"check":"has_customer_po","severity":"soft"}]}'
 WHERE stage_key = 'oc_issued';
