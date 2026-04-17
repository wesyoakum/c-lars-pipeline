// POST /opportunities/:id/quotes/:quoteId/accept
// Customer has accepted: issued/revision_issued → accepted.

import { transitionQuote } from '../../../../lib/quote-transitions.js';

export async function onRequestPost(context) {
  return transitionQuote(context, {
    from: ['issued', 'revision_issued'],
    to: 'accepted',
    eventType: 'accepted',
    summaryFn: (q) => `${q.number} Rev ${q.revision} accepted by customer`,
    fireEventName: 'quote.accepted',
  });
}
