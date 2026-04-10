-- =====================================================================
-- Migration 0004 — opportunity dates + simplified numbering
--
-- 1. Add four pipeline date columns to opportunities (rfq_received_date,
--    rfq_due_date, rfi_due_date, quoted_date) so the list/detail can
--    show the full set of milestone dates the user wants to track.
--    `created_at`, `updated_at`, and `expected_close_date` already exist.
--
-- 2. Switch the opportunity numbering scheme from the year-prefixed
--    'OPP-2026-0001' format to a bare 5-digit number starting at 25001.
--    The existing three test opportunities are renumbered in created_at
--    order: 25001, 25002, 25003. The `sequences` table gets a new
--    'opportunity' scope row seeded so the next allocated number is 25004.
--    The old 'OPP-2026' sequence row is left in place but unused — it
--    does no harm and removing it would make rollback awkward.
--
-- 3. Numbers stay editable (the column has a UNIQUE index, so manual
--    edits that collide will fail at insert/update time and be reported
--    to the user as a normal validation error).
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. New milestone date columns
-- ---------------------------------------------------------------------

ALTER TABLE opportunities ADD COLUMN rfq_received_date TEXT;
ALTER TABLE opportunities ADD COLUMN rfq_due_date      TEXT;
ALTER TABLE opportunities ADD COLUMN rfi_due_date      TEXT;
ALTER TABLE opportunities ADD COLUMN quoted_date       TEXT;


-- ---------------------------------------------------------------------
-- 2. Renumber existing opportunities
--
-- We assign 25001..25001+N-1 in created_at order. SQLite doesn't have a
-- built-in `ROW_NUMBER() OVER (...)` shortcut for UPDATE, but a
-- correlated subquery does the same job for the small N we have here.
-- ---------------------------------------------------------------------

UPDATE opportunities
   SET number = printf('%05d', 25000 + (
         SELECT COUNT(*) + 1
           FROM opportunities o2
          WHERE o2.created_at < opportunities.created_at
             OR (o2.created_at = opportunities.created_at AND o2.id < opportunities.id)
       ));


-- ---------------------------------------------------------------------
-- 3. Seed the new sequence
--
-- next_value points at the *next* number to allocate, so after this we
-- want it set to (25001 + count_of_existing_opportunities). For the
-- current 3-row dataset that's 25004; the COALESCE keeps the migration
-- correct even if more rows were added between dry-run and apply.
-- ---------------------------------------------------------------------

INSERT INTO sequences (scope, next_value)
VALUES ('opportunity',
        (SELECT COALESCE(MAX(CAST(number AS INTEGER)), 25000) + 1 FROM opportunities))
ON CONFLICT(scope) DO UPDATE
   SET next_value = excluded.next_value;
