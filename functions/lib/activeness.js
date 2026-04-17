// functions/lib/activeness.js
//
// Per-entity "active" status predicates (migration 0035).
//
// Each function returns a SQL WHERE clause fragment that selects the
// active rows for that entity type. Handlers splice them into their
// list queries when the current user has the `active_only` pref on.
//
// Definitions (confirmed with Wes, see 0035_active_only.sql):
//
//   Task         status = 'pending'
//   Job          status NOT IN ('complete','cancelled')
//                  (handed_off is still active; 'complete' is new)
//   Quote        status IN (draft, issued, revision_draft,
//                           revision_issued, accepted, expired)
//                  ('completed' is new, hidden, set by cascade
//                   when a job moves to 'complete')
//   Opportunity  stage NOT IN (closed_lost, closed_abandoned)
//                AND (no quotes OR has >= 1 active quote)
//                Note: closed_won is treated as active — a closed-won
//                deal is "live business" worth seeing in working lists
//                until the job that spawned from it finishes.
//   Contact      parent account.is_active = 1
//   Account      is_active = 1
//
// Usage pattern in a handler:
//
//   import { accountActivePredicate, isActiveOnly } from '../lib/activeness.js';
//   const where = isActiveOnly(user) ? `WHERE ${accountActivePredicate('a')}` : '';
//   const rows = await all(env.DB, `SELECT ... FROM accounts a ${where}`);
//
// The opp predicate needs a correlated subquery against `quotes`, so
// it takes the alias for `opportunities` (default `o`) and assumes the
// `quotes` table is accessible under its canonical name. The others
// are simple comparisons on a single column.
//
// Keep the shared status lists in one place so a future "add a new
// quote status" change only touches this file.

export const ACTIVE_QUOTE_STATUSES = [
  'draft',
  'issued',
  'revision_draft',
  'revision_issued',
  'accepted',
  'expired',
];

export const INACTIVE_QUOTE_STATUSES = [
  'dead',
  'rejected',
  'completed',
];

export const INACTIVE_JOB_STATUSES = [
  'complete',
  'cancelled',
];

// Stages that mark an opportunity as "inactive" for the active_only
// filter. Intentionally excludes `closed_won`: won deals stay in the
// active list until the downstream job is complete.
export const CLOSED_OPPORTUNITY_STAGES = [
  'closed_lost',
  'closed_abandoned',
];

// Separate constant for the inactive-opportunities section on the
// account detail page — kept identical to CLOSED_OPPORTUNITY_STAGES
// for now but named distinctly so intent is obvious at call sites.
export const INACTIVE_OPPORTUNITY_STAGES = CLOSED_OPPORTUNITY_STAGES;

/**
 * True when the `active_only` user pref is on.
 */
export function isActiveOnly(user) {
  return !!(user && user.active_only);
}

/**
 * Quote visibility: simple IN-list over the status column.
 * `alias` is the table alias used in the caller's query (default 'q').
 */
export function quoteActivePredicate(alias = 'q') {
  const quoted = ACTIVE_QUOTE_STATUSES.map((s) => `'${s}'`).join(', ');
  return `${alias}.status IN (${quoted})`;
}

/**
 * Job visibility: exclude the two inactive statuses.
 */
export function jobActivePredicate(alias = 'j') {
  const quoted = INACTIVE_JOB_STATUSES.map((s) => `'${s}'`).join(', ');
  return `${alias}.status NOT IN (${quoted})`;
}

/**
 * Task visibility (activities table). Pending-only.
 * `alias` is the activities alias (default 'ac' to avoid colliding with
 * the `accounts` alias `a`).
 */
export function taskActivePredicate(alias = 'ac') {
  return `${alias}.status = 'pending'`;
}

/**
 * Account visibility: the stored flag.
 */
export function accountActivePredicate(alias = 'a') {
  return `${alias}.is_active = 1`;
}

/**
 * Opportunity visibility: non-closed stage, and either no quotes yet
 * or at least one active quote. The correlated subquery is written
 * against the canonical `quotes` table name — callers don't need to
 * alias it.
 */
export function opportunityActivePredicate(alias = 'o') {
  const closed = CLOSED_OPPORTUNITY_STAGES.map((s) => `'${s}'`).join(', ');
  const activeQuote = ACTIVE_QUOTE_STATUSES.map((s) => `'${s}'`).join(', ');
  return `(
    ${alias}.stage NOT IN (${closed})
    AND (
      NOT EXISTS (SELECT 1 FROM quotes q WHERE q.opportunity_id = ${alias}.id)
      OR EXISTS (
        SELECT 1 FROM quotes q
        WHERE q.opportunity_id = ${alias}.id
          AND q.status IN (${activeQuote})
      )
    )
  )`;
}

/**
 * Contact visibility: parent account is active. Caller must JOIN
 * accounts and pass its alias (default 'a'); the contacts alias is
 * not referenced here since the join is the visibility lever.
 */
export function contactActivePredicate(accountAlias = 'a') {
  return `${accountAlias}.is_active = 1`;
}

/**
 * Compose an AND-clause for a list handler. Accepts any number of
 * non-falsy fragments and joins them with ` AND `. Returns '' if all
 * fragments are empty — avoids emitting a bare `WHERE`.
 */
export function andWhere(...fragments) {
  const parts = fragments.filter((f) => f && String(f).trim());
  if (parts.length === 0) return '';
  return parts.join(' AND ');
}
