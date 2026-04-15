-- =====================================================================
-- scripts/cleanup-test-data.sql
--
-- One-shot cleanup to wipe test data before the WFM bulk import.
-- Keeps ONLY the Oceaneering account and everything that hangs off it.
--
-- Deletes 3 test accounts + all descendants:
--   - Acme Subsea          (adfd60d2-a326-46d2-897e-b34984d0888d)   4 opps
--   - ROV Operations Ltd.  (bdf66d74-d80a-4335-8442-c528cc9cd7c8)   1 opp
--   - Super Deep Ops       (6a8255fa-d2cf-493d-96ef-06bb804019cc)   6 opps
--
-- Strategy: explicit BOTTOM-UP deletes. We do not rely on cascade
-- ordering because:
--   1. wrangler d1 execute may run each statement in a separate tx,
--      so PRAGMA defer_foreign_keys doesn't survive across statements.
--   2. jobs.opportunity_id has NO cascade (0001:296), so a doomed opp
--      with a job would block an opportunity-level delete outright.
--   3. Several 08xx / 14xx migrations added cross-refs between
--      cost_builds ↔ quote_lines / quotes / documents that force an
--      awkward null-first dance before parents can go.
--
-- Order of operations:
--   1. NULL out the non-cascading cross-references that sit on rows
--      attached to doomed opportunities:
--        a. cost_builds.quote_line_id       (0008)
--        b. quotes.supersedes_quote_id      (self-ref)
--        c. quotes.cost_build_id            (0001)
--        d. quote_lines.cost_build_id       (0007)
--        e. documents.cost_build_id         (0014)
--   2. DELETE jobs attached to doomed opps (non-cascading FK, 0001:296).
--   3. DELETE the cost_build satellites (dm/labor selections + labor).
--   4. DELETE cost_builds attached to doomed opps.
--   5. DELETE quote_lines attached to doomed opps' quotes.
--   6. DELETE quotes attached to doomed opps.
--   7. DELETE documents attached to doomed opps.
--   8. DELETE activities attached to doomed opps.
--   9. DELETE external_artifacts attached to doomed opps.
--  10. DELETE the opportunities themselves.
--  11. DELETE account-scoped children (contacts, account_addresses,
--      activities, documents, external_artifacts).
--  12. DELETE the accounts.
--
-- audit_events and notifications use free-text entity_id (no FK) so
-- they're left alone and become orphaned log rows.
-- =====================================================================

-- Belt-and-braces: defer FK checks where the runtime honors it.
PRAGMA defer_foreign_keys = ON;

-- ---------------------------------------------------------------------
-- 1. Null out non-cascading cross-references on doomed-opp descendants.
-- ---------------------------------------------------------------------

UPDATE cost_builds
SET quote_line_id = NULL
WHERE opportunity_id IN (
  SELECT id FROM opportunities
  WHERE account_id IN (
    'adfd60d2-a326-46d2-897e-b34984d0888d',
    'bdf66d74-d80a-4335-8442-c528cc9cd7c8',
    '6a8255fa-d2cf-493d-96ef-06bb804019cc'
  )
);

UPDATE quotes
SET supersedes_quote_id = NULL
WHERE opportunity_id IN (
  SELECT id FROM opportunities
  WHERE account_id IN (
    'adfd60d2-a326-46d2-897e-b34984d0888d',
    'bdf66d74-d80a-4335-8442-c528cc9cd7c8',
    '6a8255fa-d2cf-493d-96ef-06bb804019cc'
  )
);

UPDATE quotes
SET cost_build_id = NULL
WHERE opportunity_id IN (
  SELECT id FROM opportunities
  WHERE account_id IN (
    'adfd60d2-a326-46d2-897e-b34984d0888d',
    'bdf66d74-d80a-4335-8442-c528cc9cd7c8',
    '6a8255fa-d2cf-493d-96ef-06bb804019cc'
  )
);

UPDATE quote_lines
SET cost_build_id = NULL
WHERE quote_id IN (
  SELECT id FROM quotes
  WHERE opportunity_id IN (
    SELECT id FROM opportunities
    WHERE account_id IN (
      'adfd60d2-a326-46d2-897e-b34984d0888d',
      'bdf66d74-d80a-4335-8442-c528cc9cd7c8',
      '6a8255fa-d2cf-493d-96ef-06bb804019cc'
    )
  )
);

UPDATE documents
SET cost_build_id = NULL
WHERE opportunity_id IN (
  SELECT id FROM opportunities
  WHERE account_id IN (
    'adfd60d2-a326-46d2-897e-b34984d0888d',
    'bdf66d74-d80a-4335-8442-c528cc9cd7c8',
    '6a8255fa-d2cf-493d-96ef-06bb804019cc'
  )
);

-- ---------------------------------------------------------------------
-- 2. Delete jobs first — the FK is NOT cascading (0001:296).
-- ---------------------------------------------------------------------

DELETE FROM jobs
WHERE opportunity_id IN (
  SELECT id FROM opportunities
  WHERE account_id IN (
    'adfd60d2-a326-46d2-897e-b34984d0888d',
    'bdf66d74-d80a-4335-8442-c528cc9cd7c8',
    '6a8255fa-d2cf-493d-96ef-06bb804019cc'
  )
);

-- ---------------------------------------------------------------------
-- 3. Delete cost_build satellites (cascades would normally cover
--    these, but we drop them explicitly to keep the chain bottom-up).
-- ---------------------------------------------------------------------

DELETE FROM cost_build_dm_selections
WHERE cost_build_id IN (
  SELECT id FROM cost_builds
  WHERE opportunity_id IN (
    SELECT id FROM opportunities
    WHERE account_id IN (
      'adfd60d2-a326-46d2-897e-b34984d0888d',
      'bdf66d74-d80a-4335-8442-c528cc9cd7c8',
      '6a8255fa-d2cf-493d-96ef-06bb804019cc'
    )
  )
);

DELETE FROM cost_build_labor_selections
WHERE cost_build_id IN (
  SELECT id FROM cost_builds
  WHERE opportunity_id IN (
    SELECT id FROM opportunities
    WHERE account_id IN (
      'adfd60d2-a326-46d2-897e-b34984d0888d',
      'bdf66d74-d80a-4335-8442-c528cc9cd7c8',
      '6a8255fa-d2cf-493d-96ef-06bb804019cc'
    )
  )
);

DELETE FROM cost_build_labor
WHERE cost_build_id IN (
  SELECT id FROM cost_builds
  WHERE opportunity_id IN (
    SELECT id FROM opportunities
    WHERE account_id IN (
      'adfd60d2-a326-46d2-897e-b34984d0888d',
      'bdf66d74-d80a-4335-8442-c528cc9cd7c8',
      '6a8255fa-d2cf-493d-96ef-06bb804019cc'
    )
  )
);

-- ---------------------------------------------------------------------
-- 4. Delete cost_builds attached to doomed opps.
-- ---------------------------------------------------------------------

DELETE FROM cost_builds
WHERE opportunity_id IN (
  SELECT id FROM opportunities
  WHERE account_id IN (
    'adfd60d2-a326-46d2-897e-b34984d0888d',
    'bdf66d74-d80a-4335-8442-c528cc9cd7c8',
    '6a8255fa-d2cf-493d-96ef-06bb804019cc'
  )
);

-- ---------------------------------------------------------------------
-- 5. Delete quote_lines attached to doomed opps' quotes.
-- ---------------------------------------------------------------------

DELETE FROM quote_lines
WHERE quote_id IN (
  SELECT id FROM quotes
  WHERE opportunity_id IN (
    SELECT id FROM opportunities
    WHERE account_id IN (
      'adfd60d2-a326-46d2-897e-b34984d0888d',
      'bdf66d74-d80a-4335-8442-c528cc9cd7c8',
      '6a8255fa-d2cf-493d-96ef-06bb804019cc'
    )
  )
);

-- ---------------------------------------------------------------------
-- 6. Delete quotes attached to doomed opps.
-- ---------------------------------------------------------------------

DELETE FROM quotes
WHERE opportunity_id IN (
  SELECT id FROM opportunities
  WHERE account_id IN (
    'adfd60d2-a326-46d2-897e-b34984d0888d',
    'bdf66d74-d80a-4335-8442-c528cc9cd7c8',
    '6a8255fa-d2cf-493d-96ef-06bb804019cc'
  )
);

-- ---------------------------------------------------------------------
-- 7. Delete documents attached to doomed opps.
-- ---------------------------------------------------------------------

DELETE FROM documents
WHERE opportunity_id IN (
  SELECT id FROM opportunities
  WHERE account_id IN (
    'adfd60d2-a326-46d2-897e-b34984d0888d',
    'bdf66d74-d80a-4335-8442-c528cc9cd7c8',
    '6a8255fa-d2cf-493d-96ef-06bb804019cc'
  )
);

-- ---------------------------------------------------------------------
-- 8. Delete activities attached to doomed opps.
-- ---------------------------------------------------------------------

DELETE FROM activities
WHERE opportunity_id IN (
  SELECT id FROM opportunities
  WHERE account_id IN (
    'adfd60d2-a326-46d2-897e-b34984d0888d',
    'bdf66d74-d80a-4335-8442-c528cc9cd7c8',
    '6a8255fa-d2cf-493d-96ef-06bb804019cc'
  )
);

-- ---------------------------------------------------------------------
-- 9. Delete external_artifacts attached to doomed opps.
-- ---------------------------------------------------------------------

DELETE FROM external_artifacts
WHERE opportunity_id IN (
  SELECT id FROM opportunities
  WHERE account_id IN (
    'adfd60d2-a326-46d2-897e-b34984d0888d',
    'bdf66d74-d80a-4335-8442-c528cc9cd7c8',
    '6a8255fa-d2cf-493d-96ef-06bb804019cc'
  )
);

-- ---------------------------------------------------------------------
-- 10. Delete the opportunities themselves.
-- ---------------------------------------------------------------------

DELETE FROM opportunities
WHERE account_id IN (
  'adfd60d2-a326-46d2-897e-b34984d0888d',
  'bdf66d74-d80a-4335-8442-c528cc9cd7c8',
  '6a8255fa-d2cf-493d-96ef-06bb804019cc'
);

-- ---------------------------------------------------------------------
-- 11. Delete account-scoped children (before the accounts themselves)
--     so we don't rely on account-delete cascades either.
-- ---------------------------------------------------------------------

DELETE FROM documents
WHERE account_id IN (
  'adfd60d2-a326-46d2-897e-b34984d0888d',
  'bdf66d74-d80a-4335-8442-c528cc9cd7c8',
  '6a8255fa-d2cf-493d-96ef-06bb804019cc'
);

DELETE FROM activities
WHERE account_id IN (
  'adfd60d2-a326-46d2-897e-b34984d0888d',
  'bdf66d74-d80a-4335-8442-c528cc9cd7c8',
  '6a8255fa-d2cf-493d-96ef-06bb804019cc'
);

-- (external_artifacts has no account_id — it only hangs off opportunity /
-- quote / job, all of which we already cleared in step 9.)

DELETE FROM account_addresses
WHERE account_id IN (
  'adfd60d2-a326-46d2-897e-b34984d0888d',
  'bdf66d74-d80a-4335-8442-c528cc9cd7c8',
  '6a8255fa-d2cf-493d-96ef-06bb804019cc'
);

DELETE FROM contacts
WHERE account_id IN (
  'adfd60d2-a326-46d2-897e-b34984d0888d',
  'bdf66d74-d80a-4335-8442-c528cc9cd7c8',
  '6a8255fa-d2cf-493d-96ef-06bb804019cc'
);

-- ---------------------------------------------------------------------
-- 12. Finally, delete the accounts.
-- ---------------------------------------------------------------------

DELETE FROM accounts
WHERE id IN (
  'adfd60d2-a326-46d2-897e-b34984d0888d',
  'bdf66d74-d80a-4335-8442-c528cc9cd7c8',
  '6a8255fa-d2cf-493d-96ef-06bb804019cc'
);
