// POST /opportunities/:id/quotes/:quoteId/generate-pdf
//
// Generate a filled .docx from the quote template, convert to PDF via
// ConvertAPI, and store both in R2 linked to the quote.

import { one } from '../../../../lib/db.js';
import { redirectWithFlash } from '../../../../lib/http.js';
import {
  getQuoteDocData,
  fillTemplate,
  convertToPdf,
  templateKeyForQuote,
} from '../../../../lib/doc-generate.js';
import { storeGeneratedDoc } from '../../../../lib/doc-storage.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const oppId = params.id;
  const quoteId = params.quoteId;
  const returnTo = `/opportunities/${oppId}/quotes/${quoteId}`;

  // Verify quote exists and belongs to this opportunity
  const quote = await one(env.DB, 'SELECT id, opportunity_id, quote_type, number, revision FROM quotes WHERE id = ?', [quoteId]);
  if (!quote || quote.opportunity_id !== oppId) {
    return new Response('Quote not found', { status: 404 });
  }

  try {
    // 1. Load quote data
    const docData = await getQuoteDocData(env, quoteId);
    if (!docData) {
      return redirectWithFlash(returnTo, 'Could not load quote data.', 'error');
    }

    // 2. Fill the Word template
    const templateKey = templateKeyForQuote(quote.quote_type);
    const docxBuffer = await fillTemplate(env, templateKey, docData);

    const baseFilename = quote.revision && quote.revision !== 'v1'
      ? `${quote.number}-${quote.revision}`
      : quote.number;

    // 3. Convert to PDF and store (no .docx saved)

    const pdfBuffer = await convertToPdf(env, docxBuffer);

    await storeGeneratedDoc(env, {
      opportunityId: oppId,
      quoteId,
      buffer: pdfBuffer,
      filename: `${baseFilename}.pdf`,
      mimeType: 'application/pdf',
      kind: 'quote_pdf',
      user,
    });

    return redirectWithFlash(returnTo, `Generated ${baseFilename}.pdf`);
  } catch (err) {
    console.error('PDF generation failed:', err);
    return redirectWithFlash(returnTo, `PDF generation failed: ${err.message}`, 'error');
  }
}
