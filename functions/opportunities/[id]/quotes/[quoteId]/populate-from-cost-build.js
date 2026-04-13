// POST /opportunities/:id/quotes/:quoteId/populate-from-cost-build
//
// Deprecated — price builds are now per-line-item, not per-quote.
// Redirect back to the quote page.

import { redirectWithFlash } from '../../../../lib/http.js';

export async function onRequestPost(context) {
  const { params } = context;
  return redirectWithFlash(
    `/opportunities/${params.id}/quotes/${params.quoteId}`,
    'Price builds are now managed per line item.',
    'info'
  );
}
