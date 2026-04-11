// POST /opportunities/:id/quotes/:quoteId/accept
// Customer has accepted the submitted quote: submitted → accepted.

import { transitionQuote } from '../../../../lib/quote-transitions.js';

export async function onRequestPost(context) {
  return transitionQuote(context, {
    from: ['submitted'],
    to: 'accepted',
    eventType: 'accepted',
    summaryFn: (q) => `${q.number} Rev ${q.revision} accepted by customer`,
  });
}
