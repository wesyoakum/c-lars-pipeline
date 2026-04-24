// POST /opportunities/:id/quotes/:quoteId/accept
// Customer has accepted: issued/revision_issued → accepted.
//
// Side effect: advance the parent opportunity stage.
//   - Baseline quote accepted → closed_won (intermediate)
//   - Change-order quote accepted → change_order_won (mid-job)
//
// Change-order quote acceptance also flips the parent change_orders row
// to status='won' + accepted_at so the CO page reflects the state.

import { stmt, batch } from '../../../../lib/db.js';
import { transitionQuote } from '../../../../lib/quote-transitions.js';
import { changeOppStage } from '../../../../lib/stage-transitions.js';
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
      const targetStage = isCO ? 'change_order_won' : 'closed_won';
      await changeOppStage(ctx, quote.opportunity_id, targetStage, {
        reason: `${isCO ? 'Change order' : 'Quote'} ${quote.number} accepted`,
      });

      if (isCO) {
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
      }
    },
  });
}
