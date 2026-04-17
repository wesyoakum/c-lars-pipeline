// functions/lib/stage-transitions.js
//
// Programmatic opportunity stage transitions fired from quote-lifecycle
// handlers (quote created, revised, accepted, rejected, etc.). Keeps
// opp stage synchronized with the quote workflow without going through
// the /opportunities/:id/stage endpoint — this is a system trigger, not
// a user-initiated stage change, so we skip the gate / blocker UI.
//
// All failures are logged and swallowed. The quote operation that
// triggered the stage change must never roll back because a stage
// transition glitched.

import { one, stmt, batch } from './db.js';
import { auditStmt } from './audit.js';
import { now } from './ids.js';
import { stageDef } from './stages.js';
import { fireEvent } from './auto-tasks.js';

// Auto-task rule IDs whose completion advances the opp stage. Kept
// here (not in each completion handler) so every path that flips
// activities.status to 'completed' gets the same behavior via
// advanceStageOnTaskComplete().
const SUBMIT_QUOTE_RULE_ID = 'rule-seed-submit-quote-to-customer';

/**
 * Transition an opportunity's stage programmatically.
 *
 * @param {object} context  { env, data: { user }, waitUntil? }
 * @param {string} oppId
 * @param {string} toStage  target stage_key (must exist in stage_definitions)
 * @param {object} [opts]
 * @param {string} [opts.reason]        short reason appended to the audit summary
 * @param {boolean} [opts.onlyForward]  if true, skip the transition when the
 *                                      current stage has a higher/equal sort_order
 *                                      than the target (don't regress won opps
 *                                      back to quote_drafted, etc.)
 * @returns {Promise<{ changed: boolean, from: string|null, to: string, reason?: string }>}
 */
export async function changeOppStage(context, oppId, toStage, opts = {}) {
  const { env, data } = context;
  const user = data?.user;
  try {
    const opp = await one(
      env.DB,
      'SELECT * FROM opportunities WHERE id = ?',
      [oppId]
    );
    if (!opp) {
      return { changed: false, from: null, to: toStage, reason: 'opp not found' };
    }
    if (opp.stage === toStage) {
      return { changed: false, from: opp.stage, to: toStage, reason: 'already at target' };
    }

    const targetDef = await stageDef(env.DB, opp.transaction_type, toStage);
    if (!targetDef) {
      console.error(
        `changeOppStage: no stage def for ${toStage}/${opp.transaction_type}`
      );
      return {
        changed: false,
        from: opp.stage,
        to: toStage,
        reason: 'unknown stage',
      };
    }

    if (opts.onlyForward && opp.stage) {
      const currentDef = await stageDef(
        env.DB,
        opp.transaction_type,
        opp.stage
      );
      const currentSort = currentDef?.sort_order ?? 0;
      const targetSort = targetDef.sort_order ?? 0;
      if (currentSort >= targetSort) {
        return {
          changed: false,
          from: opp.stage,
          to: toStage,
          reason: 'would regress',
        };
      }
    }

    const ts = now();
    const newProbability =
      typeof targetDef.default_probability === 'number'
        ? targetDef.default_probability
        : opp.probability;

    const isTerminal = !!targetDef.is_terminal;
    const closeReason = isTerminal
      ? targetDef.is_won
        ? 'won'
        : targetDef.stage_key === 'closed_lost'
          ? 'lost'
          : 'abandoned'
      : null;

    let summary = `Stage ${opp.stage} \u2192 ${toStage}`;
    if (opts.reason) summary += ` (${opts.reason})`;

    await batch(env.DB, [
      stmt(
        env.DB,
        `UPDATE opportunities
            SET stage = ?, stage_entered_at = ?, probability = ?,
                ${isTerminal ? 'close_reason = ?, actual_close_date = ?,' : ''}
                updated_at = ?
          WHERE id = ?`,
        [
          toStage,
          ts,
          newProbability,
          ...(isTerminal ? [closeReason, ts] : []),
          ts,
          oppId,
        ]
      ),
      auditStmt(env.DB, {
        entityType: 'opportunity',
        entityId: oppId,
        eventType: 'stage_changed',
        user,
        summary,
        changes: {
          stage: { from: opp.stage, to: toStage },
          probability: { from: opp.probability, to: newProbability },
          ...(isTerminal
            ? { close_reason: { from: opp.close_reason, to: closeReason } }
            : {}),
        },
      }),
    ]);

    // Fire opportunity.stage_changed so auto-task rules (and anyone else
    // listening) see the transition. Non-blocking — failures must not
    // roll back the quote operation that triggered us.
    if (context.waitUntil) {
      context.waitUntil(
        (async () => {
          try {
            const fresh = await one(
              env.DB,
              'SELECT * FROM opportunities WHERE id = ?',
              [oppId]
            );
            const account = fresh?.account_id
              ? await one(
                  env.DB,
                  'SELECT * FROM accounts WHERE id = ?',
                  [fresh.account_id]
                )
              : null;
            await fireEvent(
              env,
              'opportunity.stage_changed',
              {
                trigger: { user, at: ts },
                opportunity: fresh,
                account,
                stage_from: opp.stage,
                stage_to: toStage,
              },
              user
            );
          } catch (err) {
            console.error(
              'changeOppStage fireEvent failed:',
              err?.message || err
            );
          }
        })()
      );
    }

    return { changed: true, from: opp.stage, to: toStage };
  } catch (err) {
    console.error('changeOppStage error:', err?.message || err);
    return {
      changed: false,
      from: null,
      to: toStage,
      reason: String(err?.message || err),
    };
  }
}

/**
 * Inspect a just-completed activity and, if it was an auto-created
 * task linked to a known rule (currently: "Submit quote to customer"),
 * advance the parent opportunity to the appropriate stage.
 *
 * Called from every path that flips `activities.status` to 'completed'
 * (patch.js, complete.js, index.js PUT) so the mapping lives in one
 * place. Safe to call even when the task is unrelated — returns
 * unchanged in that case.
 *
 * @param {object} context  request context ({ env, data: { user }, waitUntil? })
 * @param {object} task     the activities row BEFORE the status flip
 *                          (must include id, type, source_rule_id, quote_id,
 *                          opportunity_id)
 * @returns {Promise<object|null>}  changeOppStage result, or null when no
 *                                  advance applies.
 */
export async function advanceStageOnTaskComplete(context, task) {
  if (!task) return null;
  if (task.type !== 'task') return null;
  if (!task.source_rule_id || !task.quote_id || !task.opportunity_id) {
    return null;
  }

  if (task.source_rule_id === SUBMIT_QUOTE_RULE_ID) {
    try {
      const quote = await one(
        context.env.DB,
        'SELECT id, status FROM quotes WHERE id = ?',
        [task.quote_id]
      );
      let toStage = null;
      if (quote?.status === 'issued') toStage = 'quote_submitted';
      else if (quote?.status === 'revision_issued') toStage = 'revised_quote_submitted';
      if (!toStage) return null;
      return await changeOppStage(context, task.opportunity_id, toStage, {
        reason: 'Submit-quote task completed',
        onlyForward: true,
      });
    } catch (err) {
      console.error(
        'advanceStageOnTaskComplete(submit-quote) failed:',
        err?.message || err
      );
      return null;
    }
  }

  return null;
}
