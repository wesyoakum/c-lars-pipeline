// functions/lib/inactivate-blocker.js
//
// Shared gate check: "nothing can become inactive while it has an
// active downstream object or a pending task."
//
// Each status-change handler that could move an entity from active to
// inactive calls `checkInactivateBlockers(db, kind, id)` BEFORE writing.
// If the returned `blockers` array is non-empty, the caller must refuse
// the change and surface the list to the user (JSON for AJAX, flash
// message otherwise).
//
// Scope is deliberately narrow — every downstream rule below mirrors
// the active-only predicates in lib/activeness.js. When we widen
// "active" later (e.g. to include `completed` quotes in some scenarios),
// the only file to touch for the blocker logic is this one.
//
// Blocker shape:
//   { kind: 'task' | 'opportunity' | 'quote' | 'job',
//     id:   '<entity id>',
//     label: '<user-facing one-liner>',
//     resolveUrl: '<where the user can go to fix it>',
//     completeUrl: '<POST here to complete a task inline>' | undefined }
//
// Tasks get a `completeUrl` so the blocker modal can let the user
// mark them done in place. Downstream objects only get `resolveUrl`
// because closing them out is not a one-click action — the user has
// to go do whatever work that object represents.

import { all } from './db.js';
import {
  ACTIVE_QUOTE_STATUSES,
  INACTIVE_JOB_STATUSES,
  CLOSED_OPPORTUNITY_STAGES,
} from './activeness.js';

function truncate(s, max) {
  if (!s) return '';
  s = String(s);
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '\u2026';
}

/**
 * Fetch all pending tasks attached to this entity. Tasks can link
 * to an opportunity, an account, or a quote (activities table). We
 * use the matching FK depending on `kind`.
 */
async function pendingTasksFor(db, kind, id) {
  const col = (
    kind === 'opportunity' ? 'opportunity_id'
    : kind === 'account' ? 'account_id'
    : kind === 'quote' ? 'quote_id'
    : kind === 'job' ? 'job_id'
    : null
  );
  if (!col) return [];
  return all(
    db,
    `SELECT id, subject, body, due_at
       FROM activities
      WHERE ${col} = ? AND status = 'pending'
      ORDER BY COALESCE(due_at, '9999') ASC
      LIMIT 50`,
    [id]
  );
}

function tasksToBlockers(rows) {
  return rows.map((t) => ({
    kind: 'task',
    id: t.id,
    label: truncate(t.subject || t.body || '(untitled task)', 80),
    due_at: t.due_at || null,
    resolveUrl: `/activities/${encodeURIComponent(t.id)}`,
    completeUrl: `/activities/${encodeURIComponent(t.id)}/complete`,
  }));
}

/**
 * Account inactivate blockers:
 *   - any pending task on this account
 *   - any active opportunity on this account (by the same predicate
 *     the list filters use)
 */
async function accountBlockers(db, id) {
  const tasks = await pendingTasksFor(db, 'account', id);
  const activeQuoteList = ACTIVE_QUOTE_STATUSES.map((s) => `'${s}'`).join(', ');
  const closedStageList = CLOSED_OPPORTUNITY_STAGES.map((s) => `'${s}'`).join(', ');
  const opps = await all(
    db,
    `SELECT o.id, o.number, o.title, o.stage
       FROM opportunities o
      WHERE o.account_id = ?
        AND o.stage NOT IN (${closedStageList})
        AND (
          NOT EXISTS (SELECT 1 FROM quotes q WHERE q.opportunity_id = o.id)
          OR EXISTS (
            SELECT 1 FROM quotes q
             WHERE q.opportunity_id = o.id AND q.status IN (${activeQuoteList})
          )
        )
      ORDER BY o.updated_at DESC
      LIMIT 50`,
    [id]
  );
  const blockers = tasksToBlockers(tasks);
  opps.forEach((o) => {
    blockers.push({
      kind: 'opportunity',
      id: o.id,
      label: `${o.number || ''} \u2014 ${truncate(o.title || '', 60)}`.trim(),
      resolveUrl: `/opportunities/${encodeURIComponent(o.id)}`,
    });
  });
  return blockers;
}

/**
 * Opportunity inactivate blockers (called when moving to a closed_* stage):
 *   - any pending task on this opportunity
 *   - any active quote on this opportunity
 */
async function opportunityBlockers(db, id) {
  const tasks = await pendingTasksFor(db, 'opportunity', id);
  const activeQuoteList = ACTIVE_QUOTE_STATUSES.map((s) => `'${s}'`).join(', ');
  const quotes = await all(
    db,
    `SELECT q.id, q.number, q.revision, q.title, q.status
       FROM quotes q
      WHERE q.opportunity_id = ?
        AND q.status IN (${activeQuoteList})
      ORDER BY q.updated_at DESC
      LIMIT 50`,
    [id]
  );
  const blockers = tasksToBlockers(tasks);
  quotes.forEach((q) => {
    const rev = q.revision && q.revision !== 'v1' ? ` ${q.revision}` : '';
    blockers.push({
      kind: 'quote',
      id: q.id,
      label: `${q.number || ''}${rev} \u2014 ${truncate(q.title || '', 60)}`.trim(),
      resolveUrl: `/quotes/${encodeURIComponent(q.id)}`,
    });
  });
  return blockers;
}

/**
 * Quote inactivate blockers (called when moving to dead / rejected /
 * manually to any inactive status):
 *   - any pending task on this quote
 *   - any active job linked to this quote's parent opportunity
 *     (jobs don't reference quotes directly, but a quote that was
 *      accepted typically spawned a job on its opp — we use the
 *      same non-cancelled-non-complete predicate)
 */
async function quoteBlockers(db, id) {
  const tasks = await pendingTasksFor(db, 'quote', id);
  const inactiveJobList = INACTIVE_JOB_STATUSES.map((s) => `'${s}'`).join(', ');
  const jobs = await all(
    db,
    `SELECT j.id, j.number, j.title, j.status
       FROM jobs j
       JOIN quotes q ON q.opportunity_id = j.opportunity_id
      WHERE q.id = ?
        AND j.status NOT IN (${inactiveJobList})
      ORDER BY j.updated_at DESC
      LIMIT 50`,
    [id]
  );
  const blockers = tasksToBlockers(tasks);
  jobs.forEach((j) => {
    blockers.push({
      kind: 'job',
      id: j.id,
      label: `${j.number || ''} \u2014 ${truncate(j.title || '', 60)}`.trim(),
      resolveUrl: `/jobs/${encodeURIComponent(j.id)}`,
    });
  });
  return blockers;
}

/**
 * Job inactivate blockers (called when moving to complete / cancelled):
 * Jobs are the leaf of the chain (no downstream objects). We gather
 * pending tasks attached directly to the job (activities.job_id) plus
 * tasks on the parent opportunity — work in flight often still lives
 * on the opp level, and closing out the job shouldn't orphan those.
 */
async function jobBlockers(db, id) {
  const direct = await pendingTasksFor(db, 'job', id);
  const row = await all(
    db,
    `SELECT opportunity_id FROM jobs WHERE id = ?`,
    [id]
  );
  const onOpp = row.length && row[0].opportunity_id
    ? await pendingTasksFor(db, 'opportunity', row[0].opportunity_id)
    : [];
  // De-dupe in case a task has both job_id and opportunity_id set.
  const seen = Object.create(null);
  const merged = [];
  [...direct, ...onOpp].forEach((t) => {
    if (seen[t.id]) return;
    seen[t.id] = 1;
    merged.push(t);
  });
  return tasksToBlockers(merged);
}

/**
 * Public entry point. Returns a (possibly empty) array of blockers.
 * The caller decides what to do with them — typically refuse the
 * write and surface the list to the user.
 */
export async function checkInactivateBlockers(db, kind, id) {
  if (!kind || !id) return [];
  if (kind === 'account') return accountBlockers(db, id);
  if (kind === 'opportunity') return opportunityBlockers(db, id);
  if (kind === 'quote') return quoteBlockers(db, id);
  if (kind === 'job') return jobBlockers(db, id);
  return [];
}

/**
 * Convenience: build a flash-friendly summary of blockers. Used when
 * the client wasn't an XHR and we have to redirect-with-flash.
 */
export function summarizeBlockers(blockers) {
  const byKind = { task: 0, opportunity: 0, quote: 0, job: 0 };
  blockers.forEach((b) => { byKind[b.kind] = (byKind[b.kind] || 0) + 1; });
  const parts = [];
  if (byKind.task) parts.push(`${byKind.task} pending task${byKind.task === 1 ? '' : 's'}`);
  if (byKind.quote) parts.push(`${byKind.quote} active quote${byKind.quote === 1 ? '' : 's'}`);
  if (byKind.opportunity) parts.push(`${byKind.opportunity} active opportunit${byKind.opportunity === 1 ? 'y' : 'ies'}`);
  if (byKind.job) parts.push(`${byKind.job} active job${byKind.job === 1 ? '' : 's'}`);
  return parts.join(', ');
}
