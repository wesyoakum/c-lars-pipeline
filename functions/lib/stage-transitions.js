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

// Auto-task rule IDs whose completion advances the opp stage, and the
// stage each one maps to. Centralized here so every path that flips
// activities.status to 'completed' (patch.js, complete.js, index.js PUT)
// gets the same behavior via advanceStageOnTaskComplete().
//
// Value is either a static stage_key OR a resolver async (task, env) =>
// stage_key | null that can inspect the linked quote/job before picking
// the target. The submit-quote rule uses a resolver because the quote
// status determines whether we move to quote_submitted or
// revised_quote_submitted.
const SUBMIT_QUOTE_RULE_ID               = 'rule-seed-submit-quote-to-customer';
const SUBMIT_OC_RULE_ID                  = 'rule-seed-submit-oc-to-customer';
const SUBMIT_NTP_RULE_ID                 = 'rule-seed-submit-ntp-to-customer';
const SUBMIT_CHANGE_ORDER_RULE_ID        = 'rule-seed-submit-change-order-to-customer';
const SUBMIT_AMENDED_OC_RULE_ID          = 'rule-seed-submit-amended-oc-to-customer';

const TASK_RULE_STAGE_MAP = {
  // Baseline + change-order quote flows both use the same submit-task
  // rules; each rule resolves its own stage by reading the quote row.
  [SUBMIT_QUOTE_RULE_ID]: async (task, env) => {
    if (!task.quote_id) return null;
    const quote = await one(
      env.DB,
      'SELECT status FROM quotes WHERE id = ?',
      [task.quote_id]
    );
    if (quote?.status === 'issued') return 'quote_submitted';
    if (quote?.status === 'revision_issued') return 'revised_quote_submitted';
    return null;
  },
  [SUBMIT_OC_RULE_ID]:  () => 'oc_submitted',
  [SUBMIT_NTP_RULE_ID]: () => 'ntp_submitted',
  // Change-order quote: mirrors baseline-quote behavior but advances the
  // opp through the CO stages. The CO quote's `change_order_id` is
  // already set — we just read quote.status to pick first-issue vs.
  // revision.
  [SUBMIT_CHANGE_ORDER_RULE_ID]: async (task, env) => {
    if (!task.quote_id) return null;
    const quote = await one(
      env.DB,
      'SELECT status FROM quotes WHERE id = ?',
      [task.quote_id]
    );
    if (quote?.status === 'issued') return 'change_order_submitted';
    if (quote?.status === 'revision_issued') return 'revised_change_order_submitted';
    return null;
  },
  [SUBMIT_AMENDED_OC_RULE_ID]: () => 'amended_oc_submitted',
};

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
 * task bound to a known rule in TASK_RULE_STAGE_MAP, advance the
 * parent opportunity to the corresponding stage.
 *
 * Called from every path that flips `activities.status` to 'completed'
 * (patch.js, complete.js, index.js PUT) so the mapping lives in one
 * place. Safe to call on unrelated tasks — returns null in that case.
 *
 * @param {object} context  request context ({ env, data: { user }, waitUntil? })
 * @param {object} task     the activities row (pre- or post-flip — the
 *                          resolver only reads source_rule_id, quote_id,
 *                          and opportunity_id)
 * @returns {Promise<object|null>}  changeOppStage result, or null.
 */
export async function advanceStageOnTaskComplete(context, task) {
  if (!task || task.type !== 'task') return null;
  if (!task.source_rule_id || !task.opportunity_id) return null;

  const entry = TASK_RULE_STAGE_MAP[task.source_rule_id];
  if (!entry) return null;

  try {
    const toStage =
      typeof entry === 'function' ? await entry(task, context.env) : entry;
    if (!toStage) return null;
    return await changeOppStage(context, task.opportunity_id, toStage, {
      reason: `Task ${task.source_rule_id} completed`,
      onlyForward: true,
    });
  } catch (err) {
    console.error(
      `advanceStageOnTaskComplete(${task.source_rule_id}) failed:`,
      err?.message || err
    );
    return null;
  }
}
