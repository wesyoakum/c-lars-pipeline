// POST /opportunities/:id/quotes/:quoteId/submit-internal-review
// Transition draft → internal_review.

import { transitionQuote } from '../../../../lib/quote-transitions.js';

export async function onRequestPost(context) {
  return transitionQuote(context, {
    from: ['draft'],
    to: 'internal_review',
    eventType: 'sent_to_internal_review',
    summaryFn: (q) => `Sent ${q.number} Rev ${q.revision} to internal review`,
  });
}
