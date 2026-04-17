-- Migration 0035 — "Show only active records" per-user toggle + backfill.
--
-- One new pref:
--
--   active_only   When 1, all list pages and wizard pickers hide
--                 entities that aren't currently active (plus the
--                 contacts / opps / quotes / jobs they transitively
--                 imply). Defaults OFF so existing users see the
--                 same data they did before. Wizard entity-select
--                 steps each get a "Show inactive" override checkbox
--                 that reaches around the pref for one-off picks.
--
-- Per-entity definition of "active":
--
--   Task         status = 'pending'
--   Job          status NOT IN ('complete','cancelled')    -- 'complete' is new here
--   Quote        status IN ('draft','issued','revision_draft',
--                           'revision_issued','accepted','expired')
--                ('completed' is new here too — set automatically
--                 when the associated job moves to 'complete'.)
--   Opportunity  stage not in (closed_won/lost/abandoned)
--                AND (no quotes OR has at least one active quote)
--   Contact      their account is is_active = 1
--   Account      is_active = 1 (stored flag; maintained manually +
--                automatically by the opportunity-create handler)
--
-- No CHECK constraints exist on jobs.status / quotes.status today
-- (see 0001_initial.sql), so adding the new status values is a
-- documentation-only change at the schema level. Application code
-- in functions/lib/activeness.js owns the actual status lists.
--
-- Backfill strategy for accounts.is_active:
--
--   Reset every account to 0, then set 1 for accounts with an
--   "active" opportunity under the new rules. This is safer than
--   trying to reconcile in place — after the migration, a user
--   can still manually flip any account back to 1 via inline edit
--   for edge cases the rules don't capture. The inline-edit column
--   continues to be the source of truth going forward.

ALTER TABLE users ADD COLUMN active_only INTEGER NOT NULL DEFAULT 0;

-- Reset first, then recompute.
UPDATE accounts SET is_active = 0;

UPDATE accounts SET is_active = 1 WHERE id IN (
  SELECT DISTINCT o.account_id FROM opportunities o
  WHERE o.account_id IS NOT NULL
    AND o.stage NOT IN ('closed_won', 'closed_lost', 'closed_abandoned')
    AND (
      NOT EXISTS (
        SELECT 1 FROM quotes q WHERE q.opportunity_id = o.id
      )
      OR EXISTS (
        SELECT 1 FROM quotes q
        WHERE q.opportunity_id = o.id
          AND q.status IN (
            'draft','issued','revision_draft','revision_issued','accepted','expired'
          )
      )
    )
);
