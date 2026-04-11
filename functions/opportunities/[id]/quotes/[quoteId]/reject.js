// POST /opportunities/:id/quotes/:quoteId/reject
// Customer has rejected the submitted quote: submitted → rejected.

import { transitionQuote } from '../../../../lib/quote-transitions.js';

export async function onRequestPost(context) {
  return transitionQuote(context, {
    from: ['submitted'],
    to: 'rejected',
    eventType: 'rejected',
    summaryFn: (q) => `${q.number} Rev ${q.revision} rejected by customer`,
  });
}
