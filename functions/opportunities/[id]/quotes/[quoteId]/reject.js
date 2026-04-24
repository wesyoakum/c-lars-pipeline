// POST /opportunities/:id/quotes/:quoteId/reject
// Customer has rejected: issued/revision_issued → rejected.
//
// Side effect: advance the parent opportunity stage.
//   - Baseline quote rejected → closed_lost (terminal)
//   - Change-order quote rejected → job_in_progress (the baseline OC
//     still stands; the opp returns to job-in-progress so the user can
//     draft a different CO or continue the existing work).
//
// Change-order rejection also flips change_orders.status to 'rejected'.

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
    to: 'rejected',
    eventType: 'rejected',
    summaryFn: (q) => `${q.number} Rev ${q.revision} rejected by customer`,
    fireEventName: 'quote.rejected',
    afterCommit: async (ctx, quote) => {
      const isCO = !!quote.change_order_id;
      if (isCO) {
        await changeOppStage(ctx, quote.opportunity_id, 'job_in_progress', {
          reason: `Change-order ${quote.number} rejected — back to job in progress`,
        });
        const ts = now();
        await batch(env.DB, [
          stmt(env.DB,
            `UPDATE change_orders
                SET status = 'rejected', updated_at = ?
              WHERE id = ?`,
            [ts, quote.change_order_id]),
          auditStmt(env.DB, {
            entityType: 'change_order',
            entityId: quote.change_order_id,
            eventType: 'rejected',
            user,
            summary: `Change order rejected via rejection of ${quote.number} Rev ${quote.revision}`,
            changes: { status: { to: 'rejected' } },
          }),
        ]);
      } else {
        await changeOppStage(ctx, quote.opportunity_id, 'closed_lost', {
          reason: `Quote ${quote.number} rejected`,
        });
      }
    },
  });
}
