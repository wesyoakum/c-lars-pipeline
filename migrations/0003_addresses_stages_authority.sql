-- =====================================================================
-- C-LARS Pipeline — Migration 0003
--
-- Three related changes:
--   1. account_addresses table: accounts can now have multiple labeled
--      billing and physical addresses (office, shop, delivery site...).
--      Existing accounts.address_billing / accounts.address_physical are
--      backfilled into the new table and then left in place (we don't drop
--      the columns for P0 — deprecated, unused by UI going forward).
--
--   2. Stage catalog replacement. The original 13-stage flow is replaced
--      with a new 13-stage commercial flow that matches how Wes actually
--      runs the business. Existing opportunities are remapped to the new
--      keys in the same migration so the FK stays intact.
--
--      New catalog per transaction_type:
--        lead                       shared
--        rfq_received               shared
--        awaiting_client_feedback   shared
--        quote_drafted              shared
--        quote_submitted            shared
--        quote_under_revision       shared
--        revised_quote_submitted    shared
--        closed_won                 shared (intermediate — WON but
--                                   paperwork not yet issued)
--        oc_issued                  terminal for spares/refurb/service;
--                                   intermediate for eps
--        ntp_draft                  eps only
--        ntp_issued                 terminal for eps
--        closed_lost                terminal, all types
--        closed_died                terminal, all types (renamed from
--                                   "closed_abandoned")
--
--   3. opportunities.bant_authority_contact_id — the Authority field is
--      now a reference to a contact on the account (Qualification-lite,
--      née BANT-lite). The old bant_authority TEXT column is kept for
--      now as a free-text fallback.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. account_addresses
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS account_addresses (
  id                  TEXT PRIMARY KEY,
  account_id          TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL,        -- 'billing' | 'physical'
  label               TEXT,                 -- free text: 'HQ', 'Main shop', 'Delivery - Houston', ...
  address             TEXT NOT NULL,        -- multi-line street address
  is_default          INTEGER NOT NULL DEFAULT 0,  -- one default per (account, kind)
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by_user_id  TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_account_addresses_account ON account_addresses(account_id, kind);

-- Backfill: for every existing account with address text, insert a row.
-- Generated UUIDs use hex() of randomblob(16) to stay inside pure SQL.
INSERT INTO account_addresses (id, account_id, kind, label, address, is_default)
SELECT
  lower(hex(randomblob(16))),
  id,
  'billing',
  'Billing',
  address_billing,
  1
FROM accounts
WHERE address_billing IS NOT NULL AND trim(address_billing) <> '';

INSERT INTO account_addresses (id, account_id, kind, label, address, is_default)
SELECT
  lower(hex(randomblob(16))),
  id,
  'physical',
  'Physical',
  address_physical,
  1
FROM accounts
WHERE address_physical IS NOT NULL AND trim(address_physical) <> '';


-- ---------------------------------------------------------------------
-- 2. Stage catalog replacement.
--
-- Order matters because opportunities.(transaction_type, stage) is an FK
-- into stage_definitions:
--   (a) INSERT OR REPLACE the new catalog (coexists with old rows).
--   (b) UPDATE opportunities to new stage keys (shared keys like 'lead'
--       and 'rfq_received' don't need updating).
--   (c) DELETE stage_definitions rows whose keys are no longer in the
--       new catalog.
-- ---------------------------------------------------------------------

-- (a) New catalog — spares
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
  ('spares', 'closed_won',               'Closed — won',              100,  95, 0, 1, NULL),
  ('spares', 'oc_issued',                'OC issued',                 110, 100, 1, 1, NULL),
  ('spares', 'closed_lost',              'Closed — lost',             900,   0, 1, 0, NULL),
  ('spares', 'closed_died',              'Closed — died',             910,   0, 1, 0, NULL);

INSERT OR REPLACE INTO stage_definitions
  (transaction_type, stage_key, label, sort_order, default_probability, is_terminal, is_won, gate_rules_json)
VALUES
  ('refurb', 'lead',                     'Lead',                       10,   5, 0, 0, NULL),
  ('refurb', 'rfq_received',             'RFQ received',               20,  10, 0, 0, NULL),
  ('refurb', 'awaiting_client_feedback', 'Awaiting client feedback',   30,  20, 0, 0, NULL),
  ('refurb', 'quote_drafted',            'Quote drafted',              40,  40, 0, 0, NULL),
  ('refurb', 'quote_submitted',          'Quote submitted',            50,  60, 0, 0, NULL),
  ('refurb', 'quote_under_revision',     'Quote under revision',       60,  65, 0, 0, NULL),
  ('refurb', 'revised_quote_submitted',  'Revised quote submitted',    70,  75, 0, 0, NULL),
  ('refurb', 'closed_won',               'Closed — won',              100,  95, 0, 1, NULL),
  ('refurb', 'oc_issued',                'OC issued',                 110, 100, 1, 1, NULL),
  ('refurb', 'closed_lost',              'Closed — lost',             900,   0, 1, 0, NULL),
  ('refurb', 'closed_died',              'Closed — died',             910,   0, 1, 0, NULL);

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
  ('service', 'closed_won',               'Closed — won',              100,  95, 0, 1, NULL),
  ('service', 'oc_issued',                'OC issued',                 110, 100, 1, 1, NULL),
  ('service', 'closed_lost',              'Closed — lost',             900,   0, 1, 0, NULL),
  ('service', 'closed_died',              'Closed — died',             910,   0, 1, 0, NULL);

-- EPS is the odd one out: it has NTP on top of OC.
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
  ('eps', 'closed_won',               'Closed — won',              100,  95, 0, 1, NULL),
  ('eps', 'oc_issued',                'OC issued',                 110,  97, 0, 1, NULL),
  ('eps', 'ntp_draft',                'NTP draft',                 120,  98, 0, 1, NULL),
  ('eps', 'ntp_issued',               'NTP issued',                130, 100, 1, 1, NULL),
  ('eps', 'closed_lost',              'Closed — lost',             900,   0, 1, 0, NULL),
  ('eps', 'closed_died',              'Closed — died',             910,   0, 1, 0, NULL);


-- (b) Remap existing opportunities from OLD → NEW stage keys.
-- Rules:
--   qualifying       → awaiting_client_feedback
--   cost_build       → awaiting_client_feedback (internal prep → still waiting on client)
--   quote_draft      → quote_drafted
--   internal_review  → quote_drafted
--   submitted        → quote_submitted
--   negotiation      → quote_under_revision
--   verbal_win       → closed_won
--   po_received      → closed_won
--   closed_abandoned → closed_died
--   (lead, rfq_received, closed_won, closed_lost are unchanged)
--
-- The old 'closed_won' stage was terminal in the old catalog; in the new
-- catalog 'closed_won' is intermediate. We leave existing closed_won rows
-- alone — the user can advance them to oc_issued / ntp_issued manually
-- when they actually issue the paperwork.

UPDATE opportunities SET stage = 'awaiting_client_feedback' WHERE stage = 'qualifying';
UPDATE opportunities SET stage = 'awaiting_client_feedback' WHERE stage = 'cost_build';
UPDATE opportunities SET stage = 'quote_drafted'            WHERE stage = 'quote_draft';
UPDATE opportunities SET stage = 'quote_drafted'            WHERE stage = 'internal_review';
UPDATE opportunities SET stage = 'quote_submitted'          WHERE stage = 'submitted';
UPDATE opportunities SET stage = 'quote_under_revision'     WHERE stage = 'negotiation';
UPDATE opportunities SET stage = 'closed_won'               WHERE stage = 'verbal_win';
UPDATE opportunities SET stage = 'closed_won'               WHERE stage = 'po_received';
UPDATE opportunities SET stage = 'closed_died'              WHERE stage = 'closed_abandoned';


-- (c) Delete old stage_definitions rows that no longer exist in the new catalog.
DELETE FROM stage_definitions
 WHERE stage_key IN (
   'qualifying', 'cost_build', 'quote_draft', 'internal_review',
   'submitted', 'negotiation', 'verbal_win', 'po_received', 'closed_abandoned'
 );


-- ---------------------------------------------------------------------
-- 3. opportunities.bant_authority_contact_id
-- ---------------------------------------------------------------------

ALTER TABLE opportunities
  ADD COLUMN bant_authority_contact_id TEXT REFERENCES contacts(id);
