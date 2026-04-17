// POST /opportunities/:id/quotes/:quoteId/accept
// Customer has accepted: issued/revision_issued → accepted.
// Side effect: opportunity stage → closed_won.

import { transitionQuote } from '../../../../lib/quote-transitions.js';
import { changeOppStage } from '../../../../lib/stage-transitions.js';

export async function onRequestPost(context) {
  return transitionQuote(context, {
    from: ['issued', 'revision_issued'],
    to: 'accepted',
    eventType: 'accepted',
    summaryFn: (q) => `${q.number} Rev ${q.revision} accepted by customer`,
    fireEventName: 'quote.accepted',
    afterCommit: async (ctx, quote) => {
      await changeOppStage(ctx, quote.opportunity_id, 'closed_won', {
        reason: `Quote ${quote.number} accepted`,
      });
    },
  });
}
