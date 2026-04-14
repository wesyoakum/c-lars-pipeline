// POST /opportunities/:id/quotes/:quoteId/generate-docx
//
// Generate a filled .docx from the quote template and store in R2.
// No PDF conversion — for when the user just needs the Word doc.

import { one } from '../../../../lib/db.js';
import { redirect, redirectWithFlash } from '../../../../lib/http.js';
import {
  getQuoteDocData,
  fillTemplate,
  templateKeyForQuote,
} from '../../../../lib/doc-generate.js';
import { storeGeneratedDoc } from '../../../../lib/doc-storage.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const oppId = params.id;
  const quoteId = params.quoteId;
  const returnTo = `/opportunities/${oppId}/quotes/${quoteId}`;

  const quote = await one(env.DB, 'SELECT id, opportunity_id, quote_type, number, revision FROM quotes WHERE id = ?', [quoteId]);
  if (!quote || quote.opportunity_id !== oppId) {
    return new Response('Quote not found', { status: 404 });
  }

  try {
    const docData = await getQuoteDocData(env, quoteId);
    if (!docData) {
      return redirectWithFlash(returnTo, 'Could not load quote data.', 'error');
    }

    const templateKey = templateKeyForQuote(quote.quote_type);
    const docxBuffer = await fillTemplate(env, templateKey, docData);
    const baseFilename = quote.revision && quote.revision !== 'v1'
      ? `${quote.number}-${quote.revision}`
      : quote.number;

    const docId = await storeGeneratedDoc(env, {
      opportunityId: oppId,
      quoteId,
      buffer: docxBuffer,
      filename: `${baseFilename}.docx`,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      kind: 'quote_docx',
      user,
    });

    return redirect(`${returnTo}?highlight=${docId}`);
  } catch (err) {
    console.error('DOCX generation failed:', err);
    return redirectWithFlash(returnTo, `Word generation failed: ${err.message}`, 'error');
  }
}
