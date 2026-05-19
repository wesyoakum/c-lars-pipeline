// POST /opportunities/:id/quotes/:quoteId/accept
// Customer has accepted: issued/revision_issued → accepted.
//
// Side effects:
//   - Baseline quote accepted → AUTO-create the OC job (find-or-create,
//     keyed on quote_id) and advance the opp to `oc_drafted`. The user
//     no longer has to click "Start Order Confirmation"; that button is
//     now just a shortcut to the already-created job's OC form.
//   - Change-order quote accepted → change_order_won (mid-job), and the
//     parent change_orders row flips to status='won' + accepted_at so
//     the CO page reflects the state. (CO has its own amended-OC flow —
//     no baseline job is created here.)

import { stmt, batch } from '../../../../lib/db.js';
import { transitionQuote } from '../../../../lib/quote-transitions.js';
import { changeOppStage } from '../../../../lib/stage-transitions.js';
import { ensureOcJobForQuote } from '../../../../lib/oc-jobs.js';
import { auditStmt } from '../../../../lib/audit.js';
import { now } from '../../../../lib/ids.js';

export async function onRequestPost(context) {
  const { env, data } = context;
  const user = data?.user;
  return transitionQuote(context, {
    from: ['issued', 'revision_issued'],
    to: 'accepted',
    eventType: 'accepted',
    summaryFn: (q) => `${q.number} Rev ${q.revision} accepted by customer`,
    fireEventName: 'quote.accepted',
    afterCommit: async (ctx, quote) => {
      const isCO = !!quote.change_order_id;

      if (!isCO) {
        // Baseline quote: spin up the OC job immediately (idempotent —
        // find-or-create on quote_id) and land the opp in `oc_drafted`.
        // onlyForward so re-accepting (or an opp already deeper into the
        // OC/job lifecycle) never regresses the stage.
        await ensureOcJobForQuote(ctx.env, quote.id, { user });
        await changeOppStage(ctx, quote.opportunity_id, 'oc_drafted', {
          reason: `Quote ${quote.number} accepted`,
          onlyForward: true,
        });
        return;
      }

      // Change-order quote.
      await changeOppStage(ctx, quote.opportunity_id, 'change_order_won', {
        reason: `Change order ${quote.number} accepted`,
      });

      const ts = now();
      await batch(env.DB, [
        stmt(env.DB,
          `UPDATE change_orders
              SET status = 'won',
                  accepted_at = COALESCE(accepted_at, ?),
                  updated_at = ?
            WHERE id = ?`,
          [ts, ts, quote.change_order_id]),
        auditStmt(env.DB, {
          entityType: 'change_order',
          entityId: quote.change_order_id,
          eventType: 'won',
          user,
          summary: `Change order won via acceptance of ${quote.number} Rev ${quote.revision}`,
          changes: { status: { to: 'won' } },
        }),
      ]);
    },
  });
}
