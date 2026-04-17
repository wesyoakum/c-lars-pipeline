// POST /opportunities/:id/quotes/:quoteId/reject
// Customer has rejected: issued/revision_issued → rejected.
// Side effect: opportunity stage → closed_lost.

import { transitionQuote } from '../../../../lib/quote-transitions.js';
import { changeOppStage } from '../../../../lib/stage-transitions.js';

export async function onRequestPost(context) {
  return transitionQuote(context, {
    from: ['issued', 'revision_issued'],
    to: 'rejected',
    eventType: 'rejected',
    summaryFn: (q) => `${q.number} Rev ${q.revision} rejected by customer`,
    fireEventName: 'quote.rejected',
    afterCommit: async (ctx, quote) => {
      await changeOppStage(ctx, quote.opportunity_id, 'closed_lost', {
        reason: `Quote ${quote.number} rejected`,
      });
    },
  });
}
