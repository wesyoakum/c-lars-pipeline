// POST /opportunities/:id/quotes/:quoteId/reject
// Customer has rejected: issued/revision_issued → rejected.
//
// Side effect: advance the parent opportunity stage.
//   - Baseline quote rejected → closed_lost (terminal)
//   - Supplemental quote rejected → inspection_report_submitted
//     (the baseline OC still stands; the opp goes back to the point
//     before the supplemental was drafted so the user can draft a
//     different supplemental or abandon manually).

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
      if (quote.quote_kind === 'supplemental') {
        await changeOppStage(ctx, quote.opportunity_id, 'inspection_report_submitted', {
          reason: `Supplemental ${quote.number} rejected — reverting to post-inspection`,
        });
      } else {
        await changeOppStage(ctx, quote.opportunity_id, 'closed_lost', {
          reason: `Quote ${quote.number} rejected`,
        });
      }
    },
  });
}
