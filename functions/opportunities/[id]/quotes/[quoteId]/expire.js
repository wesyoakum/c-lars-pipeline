// POST /opportunities/:id/quotes/:quoteId/expire
// Mark as expired: issued/revision_issued → expired.

import { transitionQuote } from '../../../../lib/quote-transitions.js';

export async function onRequestPost(context) {
  return transitionQuote(context, {
    from: ['issued', 'revision_issued'],
    to: 'expired',
    eventType: 'expired',
    summaryFn: (q) => `${q.number} Rev ${q.revision} marked expired`,
    fireEventName: 'quote.expired',
  });
}
