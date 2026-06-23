// functions/lib/auto-task-dismiss.js
//
// Auto-task auto-dismissal.
//
// Auto-generated tasks (activities with a non-null source_rule_id) are
// reminders to do a thing — "Submit Q123 to Acme", "Follow up on Q123",
// "Submit OC 4456". Once that thing is moot — the quote got accepted /
// rejected / revised / marked dead, or the opportunity advanced past the
// stage the reminder lived in — the task should disappear on its own
// instead of nagging forever.
//
// Dismissal sets status = 'cancelled', NOT 'completed'. Completing an
// auto submit-task fires advanceStageOnTaskComplete() (stage-transitions.js)
// which drives the opp stage forward; a task that was never actually done
// must not trigger that side effect. 'cancelled' also drops the task out
// of every active-only list (lib/activeness.js taskActivePredicate).
//
// Only tasks with a source_rule_id are ever touched here. A user's own
// hand-created tasks are theirs to close.

import { all, stmt, batch } from './db.js';
import { auditStmt } from './audit.js';
import { now } from './ids.js';
import { stageDef } from './stages.js';

// Quote statuses at which a submit/follow-up auto-task tied to that quote
// is moot. revise.js flips a superseded source quote to 'dead'; a job
// completing cascades the quote to 'completed'.
export const QUOTE_DISMISS_STATUSES = [
  'accepted', 'rejected', 'dead', 'expired', 'completed',
];

// Submit-reminder rules whose task is tied to an issued document and
// becomes moot once the opportunity advances PAST the stage that the
// issuance set. Value is the stage_key the document corresponds to; we
// dismiss when the opp reaches a stage with a strictly greater sort_order
// (for the SAME transaction_type, since sort orders differ per type).
//
// Quote-linked submit rules (submit-quote, submit-change-order,
// submit-supplemental) and the quote follow-up are handled by quote
// status instead — see dismissAutoTasksForQuote.
const STAGE_REMINDER_RULES = {
  'rule-seed-submit-oc-to-customer':  'oc_submitted',
  'rule-seed-submit-ntp-to-customer': 'ntp_submitted',
};

/**
 * Cancel every pending, auto-generated task linked to a quote. Called
 * when the quote reaches a status that makes its submit / follow-up
 * reminders pointless.
 *
 * @returns {Promise<number>} count of tasks dismissed
 */
export async function dismissAutoTasksForQuote(context, quoteId, reason) {
  const { env } = context;
  if (!env?.DB || !quoteId) return 0;
  const tasks = await all(
    env.DB,
    `SELECT id, subject, source_rule_id
       FROM activities
      WHERE quote_id = ?
        AND type = 'task'
        AND status = 'pending'
        AND source_rule_id IS NOT NULL
        AND deleted_at IS NULL`,
    [quoteId]
  );
  return dismissTasks(context, tasks, reason);
}

/**
 * Cancel pending auto-generated submit-reminder tasks on an opportunity
 * once it has advanced past the stage their document corresponds to.
 * Called from changeOppStage after a forward transition commits.
 *
 * @returns {Promise<number>} count of tasks dismissed
 */
export async function dismissAutoTasksForStage(context, oppId, transactionType, newStage) {
  const { env } = context;
  if (!env?.DB || !oppId || !newStage) return 0;

  const newDef = await stageDef(env.DB, transactionType, newStage);
  const newSort = newDef?.sort_order;
  if (newSort == null) return 0;

  // Which reminder rules are moot now that the opp sits at newStage?
  const mootRuleIds = [];
  for (const [ruleId, stageKey] of Object.entries(STAGE_REMINDER_RULES)) {
    const def = await stageDef(env.DB, transactionType, stageKey);
    if (def?.sort_order != null && newSort > def.sort_order) {
      mootRuleIds.push(ruleId);
    }
  }
  if (mootRuleIds.length === 0) return 0;

  const placeholders = mootRuleIds.map(() => '?').join(',');
  const tasks = await all(
    env.DB,
    `SELECT id, subject, source_rule_id
       FROM activities
      WHERE opportunity_id = ?
        AND type = 'task'
        AND status = 'pending'
        AND source_rule_id IN (${placeholders})
        AND deleted_at IS NULL`,
    [oppId, ...mootRuleIds]
  );
  return dismissTasks(context, tasks, `opportunity advanced to ${newStage}`);
}

/**
 * Shared writer: flip a set of pending tasks to 'cancelled' with an
 * audit row each, in one batch. Never throws — a dismissal failure must
 * not roll back the transition that triggered it.
 */
async function dismissTasks(context, tasks, reason) {
  const { env, data } = context;
  const user = data?.user;
  if (!tasks || tasks.length === 0) return 0;

  const ts = now();
  const statements = [];
  for (const t of tasks) {
    statements.push(
      stmt(
        env.DB,
        `UPDATE activities
            SET status = 'cancelled', updated_at = ?
          WHERE id = ? AND status = 'pending'`,
        [ts, t.id]
      )
    );
    statements.push(
      auditStmt(env.DB, {
        entityType: 'activity',
        entityId: t.id,
        eventType: 'cancelled',
        user,
        summary: `Auto-dismissed: ${t.subject || '(untitled task)'}${reason ? ` — ${reason}` : ''}`,
        changes: {
          status: { from: 'pending', to: 'cancelled' },
          auto_dismissed: true,
          source_rule_id: t.source_rule_id,
        },
      })
    );
  }

  try {
    await batch(env.DB, statements);
    return tasks.length;
  } catch (err) {
    console.error('auto-task-dismiss: batch failed:', err?.message || err);
    return 0;
  }
}
