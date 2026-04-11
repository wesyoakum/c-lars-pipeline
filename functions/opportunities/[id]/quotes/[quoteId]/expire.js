// POST /opportunities/:id/quotes/:quoteId/expire
// Mark a submitted quote as expired (validity passed without response).

import { transitionQuote } from '../../../../lib/quote-transitions.js';

export async function onRequestPost(context) {
  return transitionQuote(context, {
    from: ['submitted'],
    to: 'expired',
    eventType: 'expired',
    summaryFn: (q) => `${q.number} Rev ${q.revision} marked expired`,
  });
}
