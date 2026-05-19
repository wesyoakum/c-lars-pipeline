// POST /opportunities/:id/quotes/:quoteId/expire
// Mark as expired: issued/revision_issued → expired.
//
// Side effect (baseline quotes only): advance the parent opportunity
// to the `quote_expired` stage (added in migration 0092). onlyForward
// prevents a stale CO-era quote from yanking an in-flight job back
// into the quote cycle. Change-order quotes have their own lifecycle
// (change_order_*), so we don't touch the opp stage from a CO expire.

import { transitionQuote } from '../../../../lib/quote-transitions.js';
import { changeOppStage } from '../../../../lib/stage-transitions.js';

export async function onRequestPost(context) {
  return transitionQuote(context, {
    from: ['issued', 'revision_issued'],
    to: 'expired',
    eventType: 'expired',
    summaryFn: (q) => `${q.number} Rev ${q.revision} marked expired`,
    fireEventName: 'quote.expired',
    afterCommit: async (ctx, quote) => {
      if (quote.change_order_id) return;
      await changeOppStage(ctx, quote.opportunity_id, 'quote_expired', {
        reason: `Quote ${quote.number} expired`,
        onlyForward: true,
      });
    },
  });
}
