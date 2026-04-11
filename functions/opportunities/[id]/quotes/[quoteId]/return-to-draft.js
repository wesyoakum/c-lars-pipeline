// POST /opportunities/:id/quotes/:quoteId/return-to-draft
// Return from internal_review or approved_internal back to draft so
// the quote can be edited again.

import { transitionQuote } from '../../../../lib/quote-transitions.js';

export async function onRequestPost(context) {
  return transitionQuote(context, {
    from: ['internal_review', 'approved_internal'],
    to: 'draft',
    eventType: 'returned_to_draft',
    summaryFn: (q) => `Returned ${q.number} Rev ${q.revision} to draft`,
  });
}
