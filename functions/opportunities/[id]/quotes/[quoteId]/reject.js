// POST /opportunities/:id/quotes/:quoteId/reject
// Customer has rejected: issued/revision_issued → rejected.

import { transitionQuote } from '../../../../lib/quote-transitions.js';

export async function onRequestPost(context) {
  return transitionQuote(context, {
    from: ['issued', 'revision_issued'],
    to: 'rejected',
    eventType: 'rejected',
    summaryFn: (q) => `${q.number} Rev ${q.revision} rejected by customer`,
    fireEventName: 'quote.rejected',
  });
}
