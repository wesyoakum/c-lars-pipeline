-- =====================================================================
-- Migration 0045: Change Orders (universal).
--
-- Replaces the refurb-only supplemental quote + inspection report +
-- amended OC trio (migrations 0041 stages 11–18 and 0043 schema/rules)
-- with a single universal Change Order mechanism available on any job
-- (spares, service, EPS, refurb) any time after the job is created.
--
-- See `Replace Supplemental Quote with Universal Change Order` plan.
--
-- Schema changes:
--   - NEW TABLE `change_orders` (one row per CO; a job can have many).
--   - NEW COLUMN `opportunities.change_order` INTEGER  (NULL/0/1 toggle
--     that replaces `opportunities.supplemental_quote`).
--   - NEW COLUMN `quotes.change_order_id`  TEXT  (FK to change_orders;
--     replaces `quote_kind='supplemental'` as the "this quote belongs
--     to a CO" marker).
--
-- Deprecated columns (left in schema for historical reads; not written
-- by new code):
--   - quotes.quote_kind
--   - opportunities.supplemental_quote
--   - jobs.amended_oc_*  (4 cols)  — moved to change_orders
--   - jobs.inspection_report_*  (2 cols)  — inspection reports leave
--     the PMS entirely
--
-- Stage catalog rewrite (all four transaction_types):
--   Remove refurb-only supplemental/inspection_report stages.
--   Add universal `job_in_progress` + CO loop stages.
--
-- Auto-task rules:
--   DELETE old supplemental rules.
--   INSERT new CO submit-quote + submit-amended-OC rules.
-- =====================================================================


-- ---------------------------------------------------------------------
-- (a) New `change_orders` table.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS change_orders (
  id                           TEXT PRIMARY KEY,
  number                       TEXT NOT NULL UNIQUE,
  opportunity_id               TEXT NOT NULL REFERENCES opportunities(id),
  job_id                       TEXT NOT NULL REFERENCES jobs(id),
  sequence                     INTEGER NOT NULL,
  status                       TEXT NOT NULL DEFAULT 'drafted',
  description                  TEXT,
  amended_oc_number            TEXT,
  amended_oc_issued_at         TEXT,
  amended_oc_issued_by_user_id TEXT REFERENCES users(id),
  amended_oc_revision          INTEGER NOT NULL DEFAULT 1,
  accepted_at                  TEXT,
  accepted_po_number           TEXT,
  created_at                   TEXT NOT NULL,
  updated_at                   TEXT NOT NULL,
  created_by_user_id           TEXT REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_change_orders_job ON change_orders(job_id);
CREATE INDEX IF NOT EXISTS idx_change_orders_opp ON change_orders(opportunity_id);


-- ---------------------------------------------------------------------
-- (b) `opportunities.change_order` — tri-state toggle.
--     NULL = not decided, 0 = no CO, 1 = CO active (stage picker shows
--     CO loop stages).
-- ---------------------------------------------------------------------

ALTER TABLE opportunities ADD COLUMN change_order INTEGER;


-- ---------------------------------------------------------------------
-- (c) `quotes.change_order_id` — FK; NULL for baseline quotes.
-- ---------------------------------------------------------------------

ALTER TABLE quotes ADD COLUMN change_order_id TEXT REFERENCES change_orders(id);
CREATE INDEX IF NOT EXISTS idx_quotes_change_order ON quotes(change_order_id);


-- ---------------------------------------------------------------------
-- (d) Stage catalog — rewrite for all four transaction_types.
--     INSERT OR REPLACE the full per-type catalog so any existing rows
--     from 0041 get overwritten cleanly. Old supplemental stages get
--     deleted at the end of this migration.
-- ---------------------------------------------------------------------

-- Spares
INSERT OR REPLACE INTO stage_definitions
  (transaction_type, stage_key, label, sort_order, default_probability, is_terminal, is_won, gate_rules_json)
VALUES
  ('spares', 'lead',                          'Lead',                          10,   5, 0, 0, NULL),
  ('spares', 'rfq_received',                  'RFQ received',                  20,  10, 0, 0, NULL),
  ('spares', 'awaiting_client_feedback',      'Awaiting client feedback',      30,  20, 0, 0, NULL),
  ('spares', 'quote_drafted',                 'Quote drafted',                 40,  40, 0, 0, NULL),
  ('spares', 'quote_submitted',               'Quote submitted',               50,  60, 0, 0, NULL),
  ('spares', 'quote_under_revision',          'Quote under revision',          60,  65, 0, 0, NULL),
  ('spares', 'revised_quote_submitted',       'Revised quote submitted',       70,  75, 0, 0, NULL),
  ('spares', 'closed_won',                    'Won',                          100,  95, 0, 1, NULL),
  ('spares', 'oc_drafted',                    'OC drafted',                   110,  97, 0, 1, NULL),
  ('spares', 'oc_submitted',                  'OC submitted',                 120,  98, 0, 1, NULL),
  ('spares', 'job_in_progress',               'Job in progress',              130,  99, 0, 1, NULL),
  ('spares', 'change_order_drafted',          'Change order drafted',         140,  99, 0, 1, NULL),
  ('spares', 'change_order_submitted',        'Change order submitted',       150,  99, 0, 1, NULL),
  ('spares', 'change_order_under_revision',   'Change order under revision',  160,  99, 0, 1, NULL),
  ('spares', 'revised_change_order_submitted','Revised change order submitted',170,  99, 0, 1, NULL),
  ('spares', 'change_order_won',              'Change order won',             180,  99, 0, 1, NULL),
  ('spares', 'amended_oc_drafted',            'Amended OC drafted',           190,  99, 0, 1, NULL),
  ('spares', 'amended_oc_submitted',          'Amended OC submitted',         200,  99, 0, 1, NULL),
  ('spares', 'completed',                     'Completed',                    210, 100, 1, 1, NULL),
  ('spares', 'closed_lost',                   'Closed — lost',                900,   0, 1, 0, NULL),
  ('spares', 'closed_died',                   'Closed — died',                910,   0, 1, 0, NULL);

-- Service
INSERT OR REPLACE INTO stage_definitions
  (transaction_type, stage_key, label, sort_order, default_probability, is_terminal, is_won, gate_rules_json)
VALUES
  ('service', 'lead',                          'Lead',                          10,   5, 0, 0, NULL),
  ('service', 'rfq_received',                  'RFQ received',                  20,  10, 0, 0, NULL),
  ('service', 'awaiting_client_feedback',      'Awaiting client feedback',      30,  20, 0, 0, NULL),
  ('service', 'quote_drafted',                 'Quote drafted',                 40,  40, 0, 0, NULL),
  ('service', 'quote_submitted',               'Quote submitted',               50,  60, 0, 0, NULL),
  ('service', 'quote_under_revision',          'Quote under revision',          60,  65, 0, 0, NULL),
  ('service', 'revised_quote_submitted',       'Revised quote submitted',       70,  75, 0, 0, NULL),
  ('service', 'closed_won',                    'Won',                          100,  95, 0, 1, NULL),
  ('service', 'oc_drafted',                    'OC drafted',                   110,  97, 0, 1, NULL),
  ('service', 'oc_submitted',                  'OC submitted',                 120,  98, 0, 1, NULL),
  ('service', 'job_in_progress',               'Job in progress',              130,  99, 0, 1, NULL),
  ('service', 'change_order_drafted',          'Change order drafted',         140,  99, 0, 1, NULL),
  ('service', 'change_order_submitted',        'Change order submitted',       150,  99, 0, 1, NULL),
  ('service', 'change_order_under_revision',   'Change order under revision',  160,  99, 0, 1, NULL),
  ('service', 'revised_change_order_submitted','Revised change order submitted',170,  99, 0, 1, NULL),
  ('service', 'change_order_won',              'Change order won',             180,  99, 0, 1, NULL),
  ('service', 'amended_oc_drafted',            'Amended OC drafted',           190,  99, 0, 1, NULL),
  ('service', 'amended_oc_submitted',          'Amended OC submitted',         200,  99, 0, 1, NULL),
  ('service', 'completed',                     'Completed',                    210, 100, 1, 1, NULL),
  ('service', 'closed_lost',                   'Closed — lost',                900,   0, 1, 0, NULL),
  ('service', 'closed_died',                   'Closed — died',                910,   0, 1, 0, NULL);

-- EPS (adds NTP between OC and job_in_progress)
INSERT OR REPLACE INTO stage_definitions
  (transaction_type, stage_key, label, sort_order, default_probability, is_terminal, is_won, gate_rules_json)
VALUES
  ('eps', 'lead',                          'Lead',                          10,   5, 0, 0, NULL),
  ('eps', 'rfq_received',                  'RFQ received',                  20,  10, 0, 0, NULL),
  ('eps', 'awaiting_client_feedback',      'Awaiting client feedback',      30,  20, 0, 0, NULL),
  ('eps', 'quote_drafted',                 'Quote drafted',                 40,  40, 0, 0, NULL),
  ('eps', 'quote_submitted',               'Quote submitted',               50,  60, 0, 0, NULL),
  ('eps', 'quote_under_revision',          'Quote under revision',          60,  65, 0, 0, NULL),
  ('eps', 'revised_quote_submitted',       'Revised quote submitted',       70,  75, 0, 0, NULL),
  ('eps', 'closed_won',                    'Won',                          100,  95, 0, 1, NULL),
  ('eps', 'oc_drafted',                    'OC drafted',                   110,  96, 0, 1, NULL),
  ('eps', 'oc_submitted',                  'OC submitted',                 120,  97, 0, 1, NULL),
  ('eps', 'ntp_drafted',                   'NTP drafted',                  130,  97, 0, 1, NULL),
  ('eps', 'ntp_submitted',                 'NTP submitted',                140,  98, 0, 1, NULL),
  ('eps', 'job_in_progress',               'Job in progress',              150,  99, 0, 1, NULL),
  ('eps', 'change_order_drafted',          'Change order drafted',         160,  99, 0, 1, NULL),
  ('eps', 'change_order_submitted',        'Change order submitted',       170,  99, 0, 1, NULL),
  ('eps', 'change_order_under_revision',   'Change order under revision',  180,  99, 0, 1, NULL),
  ('eps', 'revised_change_order_submitted','Revised change order submitted',190,  99, 0, 1, NULL),
  ('eps', 'change_order_won',              'Change order won',             200,  99, 0, 1, NULL),
  ('eps', 'amended_oc_drafted',            'Amended OC drafted',           210,  99, 0, 1, NULL),
  ('eps', 'amended_oc_submitted',          'Amended OC submitted',         220,  99, 0, 1, NULL),
  ('eps', 'completed',                     'Completed',                    230, 100, 1, 1, NULL),
  ('eps', 'closed_lost',                   'Closed — lost',                900,   0, 1, 0, NULL),
  ('eps', 'closed_died',                   'Closed — died',                910,   0, 1, 0, NULL);

-- Refurb (no inspection report stage anymore — inspection leaves the PMS)
INSERT OR REPLACE INTO stage_definitions
  (transaction_type, stage_key, label, sort_order, default_probability, is_terminal, is_won, gate_rules_json)
VALUES
  ('refurb', 'lead',                          'Lead',                          10,   5, 0, 0, NULL),
  ('refurb', 'rfq_received',                  'RFQ received',                  20,  10, 0, 0, NULL),
  ('refurb', 'awaiting_client_feedback',      'Awaiting client feedback',      30,  20, 0, 0, NULL),
  ('refurb', 'quote_drafted',                 'Quote drafted',                 40,  40, 0, 0, NULL),
  ('refurb', 'quote_submitted',               'Quote submitted',               50,  60, 0, 0, NULL),
  ('refurb', 'quote_under_revision',          'Quote under revision',          60,  65, 0, 0, NULL),
  ('refurb', 'revised_quote_submitted',       'Revised quote submitted',       70,  75, 0, 0, NULL),
  ('refurb', 'closed_won',                    'Won',                          100,  90, 0, 1, NULL),
  ('refurb', 'oc_drafted',                    'OC drafted',                   110,  92, 0, 1, NULL),
  ('refurb', 'oc_submitted',                  'OC submitted',                 120,  93, 0, 1, NULL),
  ('refurb', 'job_in_progress',               'Job in progress',              130,  95, 0, 1, NULL),
  ('refurb', 'change_order_drafted',          'Change order drafted',         140,  96, 0, 1, NULL),
  ('refurb', 'change_order_submitted',        'Change order submitted',       150,  97, 0, 1, NULL),
  ('refurb', 'change_order_under_revision',   'Change order under revision',  160,  97, 0, 1, NULL),
  ('refurb', 'revised_change_order_submitted','Revised change order submitted',170,  98, 0, 1, NULL),
  ('refurb', 'change_order_won',              'Change order won',             180,  98, 0, 1, NULL),
  ('refurb', 'amended_oc_drafted',            'Amended OC drafted',           190,  99, 0, 1, NULL),
  ('refurb', 'amended_oc_submitted',          'Amended OC submitted',         200,  99, 0, 1, NULL),
  ('refurb', 'completed',                     'Completed',                    210, 100, 1, 1, NULL),
  ('refurb', 'closed_lost',                   'Closed — lost',                900,   0, 1, 0, NULL),
  ('refurb', 'closed_died',                   'Closed — died',                910,   0, 1, 0, NULL);


-- ---------------------------------------------------------------------
-- (e) Remap existing opportunities whose stage is going away.
--     Runs BEFORE the DELETE below so no opp ever points at a missing
--     stage_definitions row. FK was dropped in 0028 but the carousel
--     helper still fails gracefully on an unknown key, so this is a
--     data-hygiene step rather than a hard constraint.
-- ---------------------------------------------------------------------

-- Inspection-report stage goes away entirely — surviving opps move to
-- job_in_progress (which is the new "inside the job, outside the CO
-- loop" bucket).
UPDATE opportunities
   SET stage = 'job_in_progress'
 WHERE transaction_type = 'refurb'
   AND stage = 'inspection_report_submitted';

-- Supplemental stages remap to their CO equivalents.
UPDATE opportunities
   SET stage = 'change_order_drafted'
 WHERE stage = 'supplemental_quote_drafted';

UPDATE opportunities
   SET stage = 'change_order_submitted'
 WHERE stage = 'supplemental_quote_submitted';

UPDATE opportunities
   SET stage = 'change_order_under_revision'
 WHERE stage = 'supplemental_quote_under_revision';

UPDATE opportunities
   SET stage = 'revised_change_order_submitted'
 WHERE stage = 'revised_supplemental_quote_submitted';

UPDATE opportunities
   SET stage = 'change_order_won'
 WHERE stage = 'supplemental_won';


-- Any opp sitting at oc_submitted should move to job_in_progress if the
-- job has been handed off. Otherwise leave it where it is — OC just
-- submitted, handover not yet done. Conservative: only move when job
-- status is 'handed_off'.
UPDATE opportunities
   SET stage = 'job_in_progress'
 WHERE stage = 'oc_submitted'
   AND id IN (SELECT opportunity_id FROM jobs WHERE status = 'handed_off');

-- Any opp at ntp_submitted whose job is handed_off → job_in_progress.
UPDATE opportunities
   SET stage = 'job_in_progress'
 WHERE stage = 'ntp_submitted'
   AND id IN (SELECT opportunity_id FROM jobs WHERE status = 'handed_off');


-- ---------------------------------------------------------------------
-- (f) Data migration: supplemental quotes → change orders.
--     For each quote with quote_kind = 'supplemental', synthesize a
--     change_orders row on the parent job, link the quote via
--     change_order_id, and copy any amended_oc_* data off the job onto
--     the CO row. Flip opportunities.change_order = 1.
--
--     We group by job_id so all supplemental quotes on the same job
--     share one change_orders row (sequence = 1). This preserves the
--     baseline → one-supplemental-lineage semantics of the old flow.
--
--     Timestamp note: we use strftime('now') for created_at/updated_at
--     since there isn't a reliable "when did this supplemental cycle
--     start" field. The earliest quote.created_at could be queried but
--     the imprecision is fine — historical data.
-- ---------------------------------------------------------------------

-- Synthesize CO rows (one per job with ≥1 supplemental quote).
INSERT INTO change_orders (
  id, number, opportunity_id, job_id, sequence, status,
  description,
  amended_oc_number, amended_oc_issued_at, amended_oc_issued_by_user_id,
  amended_oc_revision,
  created_at, updated_at, created_by_user_id
)
SELECT
  -- Deterministic id so re-running the migration wouldn't duplicate.
  'co-migr-' || j.id AS id,
  'CO-MIGR-' || j.number AS number,
  j.opportunity_id,
  j.id AS job_id,
  1 AS sequence,
  -- Derive status from the newest supplemental quote on this job.
  COALESCE(
    (SELECT CASE
              WHEN q.status = 'accepted' THEN 'won'
              WHEN q.status = 'rejected' THEN 'rejected'
              WHEN q.status IN ('issued','revision_issued') THEN 'submitted'
              WHEN q.status IN ('draft','revision_draft') THEN 'drafted'
              WHEN q.status = 'dead'     THEN 'cancelled'
              ELSE 'drafted'
            END
       FROM quotes q
      WHERE q.opportunity_id = j.opportunity_id
        AND q.quote_kind = 'supplemental'
      ORDER BY q.created_at DESC
      LIMIT 1),
    'drafted'
  ) AS status,
  'Migrated from supplemental quote flow (0045).' AS description,
  j.amended_oc_number,
  j.amended_oc_issued_at,
  j.amended_oc_issued_by_user_id,
  COALESCE(j.amended_oc_revision, 1) AS amended_oc_revision,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  NULL
FROM jobs j
WHERE j.opportunity_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM quotes q
     WHERE q.opportunity_id = j.opportunity_id
       AND q.quote_kind = 'supplemental'
  )
  AND NOT EXISTS (
    SELECT 1 FROM change_orders co WHERE co.id = 'co-migr-' || j.id
  );

-- Link the supplemental quotes to their new change_orders row.
UPDATE quotes
   SET change_order_id = (
     SELECT co.id FROM change_orders co
      JOIN jobs j ON j.id = co.job_id
     WHERE j.opportunity_id = quotes.opportunity_id
       AND co.id LIKE 'co-migr-%'
     LIMIT 1
   )
 WHERE quote_kind = 'supplemental'
   AND change_order_id IS NULL;

-- Flip opportunities.change_order = 1 for every opp that has a
-- migrated CO.
UPDATE opportunities
   SET change_order = 1
 WHERE id IN (
   SELECT opportunity_id FROM change_orders WHERE id LIKE 'co-migr-%'
 );


-- ---------------------------------------------------------------------
-- (g) Remove dead stage rows (supplemental loop + inspection report).
--     Run AFTER the opportunity remap above so no FK dangles.
-- ---------------------------------------------------------------------

DELETE FROM stage_definitions
 WHERE stage_key IN (
   'inspection_report_submitted',
   'supplemental_quote_drafted',
   'supplemental_quote_submitted',
   'supplemental_quote_under_revision',
   'revised_supplemental_quote_submitted',
   'supplemental_won'
 );


-- ---------------------------------------------------------------------
-- (h) Deseed obsolete auto-task rules.
-- ---------------------------------------------------------------------

DELETE FROM task_rules
 WHERE id IN (
   'rule-seed-submit-inspection-report-to-customer',
   'rule-seed-submit-supplemental-quote-to-customer',
   'rule-seed-submit-amended-oc-to-customer'
 );


-- ---------------------------------------------------------------------
-- (i) Seed new CO-related auto-task rules.
-- ---------------------------------------------------------------------

INSERT INTO task_rules (
  id, name, description, trigger, conditions_json, task_json, tz, active, created_at, updated_at
) VALUES (
  'rule-seed-submit-change-order-to-customer',
  'Submit change order to customer',
  'When a change-order quote is issued (quote.change_order_id set), create a task on the opportunity owner to submit it. Completing the task advances the opp to Change order submitted (or Revised change order submitted).',
  'change_order.issued',
  NULL,
  '{"title":"Submit change order {quote.number} to {account.name}","body":"Send change order quote {quote.number} rev {quote.revision} to {account.name}.","assignee":"opportunity.owner","due_at":"+1d@cob","reminders":[],"link":"quote"}',
  'America/Chicago',
  1,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
);

INSERT INTO task_rules (
  id, name, description, trigger, conditions_json, task_json, tz, active, created_at, updated_at
) VALUES (
  'rule-seed-submit-amended-oc-to-customer',
  'Submit amended OC to customer',
  'When an amended OC is issued on a change order, create a task for the opportunity owner to submit it. Completing the task advances the opp to Amended OC submitted.',
  'change_order.amended_oc_issued',
  NULL,
  '{"title":"Submit amended OC {change_order.amended_oc_number} to {account.name}","body":"Send amended OC {change_order.amended_oc_number} for {opportunity.number} to {account.name}.","assignee":"opportunity.owner","due_at":"+1d@cob","reminders":[],"link":"opportunity"}',
  'America/Chicago',
  1,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
);


-- =====================================================================
-- End of 0045.
-- =====================================================================
