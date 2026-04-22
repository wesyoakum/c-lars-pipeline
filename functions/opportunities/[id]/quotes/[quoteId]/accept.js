// POST /opportunities/:id/quotes/:quoteId/accept
// Customer has accepted: issued/revision_issued → accepted.
//
// Side effect: advance the parent opportunity stage.
//   - Baseline quote accepted → closed_won (intermediate)
//   - Supplemental quote accepted → supplemental_won (refurb only)

import { one } from '../../../../lib/db.js';
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
      // Fresh read — quote passed to afterCommit is pre-transition, we
      // just need quote_kind which doesn't change on accept.
      const targetStage = quote.quote_kind === 'supplemental'
        ? 'supplemental_won'
        : 'closed_won';
      await changeOppStage(ctx, quote.opportunity_id, targetStage, {
        reason: `${quote.quote_kind === 'supplemental' ? 'Supplemental' : 'Quote'} ${quote.number} accepted`,
      });
    },
  });
}
