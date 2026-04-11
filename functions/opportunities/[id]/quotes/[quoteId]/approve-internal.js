// POST /opportunities/:id/quotes/:quoteId/approve-internal
// Transition internal_review → approved_internal.

import { transitionQuote } from '../../../../lib/quote-transitions.js';

export async function onRequestPost(context) {
  return transitionQuote(context, {
    from: ['internal_review'],
    to: 'approved_internal',
    eventType: 'approved_internal',
    summaryFn: (q) => `Internal approval on ${q.number} Rev ${q.revision}`,
  });
}
