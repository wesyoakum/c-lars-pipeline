// POST /opportunities/:id/quotes/:quoteId/generate-pdf
//
// Generate a filled .docx from the quote template, convert to PDF via
// ConvertAPI, and store both in R2 linked to the quote.

import { one } from '../../../../lib/db.js';
import { redirect, redirectWithFlash } from '../../../../lib/http.js';
import {
  getQuoteDocData,
  fillTemplate,
  convertToPdf,
  resolveQuoteTemplateKey,
} from '../../../../lib/doc-generate.js';
import { storeGeneratedDoc } from '../../../../lib/doc-storage.js';
import {
  getFilenameTemplate,
  renderFilenameTemplate,
  buildQuoteFilenameContext,
} from '../../../../lib/filename-templates.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const oppId = params.id;
  const quoteId = params.quoteId;
  const returnTo = `/opportunities/${oppId}/quotes/${quoteId}`;

  // Verify quote exists and belongs to this opportunity
  const quote = await one(env.DB, 'SELECT id, opportunity_id, quote_type, number, revision, title FROM quotes WHERE id = ?', [quoteId]);
  if (!quote || quote.opportunity_id !== oppId) {
    return new Response('Quote not found', { status: 404 });
  }

  try {
    // 1. Load quote data
    const docData = await getQuoteDocData(env, quoteId);
    if (!docData) {
      return redirectWithFlash(returnTo, 'Could not load quote data.', 'error');
    }

    // 2. Fill the Word template. Hybrid quotes try the dedicated
    //    quote-hybrid.docx first, falling back to the primary type's
    //    template if the hybrid one hasn't been uploaded yet.
    const { key: templateKey, usedFallback } =
      await resolveQuoteTemplateKey(env, quote.quote_type);
    const docxBuffer = await fillTemplate(env, templateKey, docData);

    // 3. Build the download filename from the admin-configurable
    //    template. Fall back to the legacy "number-rev.pdf" shape
    //    if the row is somehow missing so generation never breaks.
    const fnCtx = buildQuoteFilenameContext({
      quote,
      accountName:       docData.clientName,
      accountAlias:      docData.clientAlias,
      opportunityNumber: docData.opportunityNumber,
      opportunityTitle:  docData.opportunityTitle,
    });
    const fnTpl = await getFilenameTemplate(
      env,
      'quote_pdf',
      '{quoteNumber}{revisionSuffix}.pdf'
    );
    const pdfFilename =
      renderFilenameTemplate(fnTpl, fnCtx) ||
      `${quote.number}${fnCtx.revisionSuffix}.pdf`;

    // 4. Convert to PDF and store (no .docx saved)

    const pdfBuffer = await convertToPdf(env, docxBuffer);

    const docId = await storeGeneratedDoc(env, {
      opportunityId: oppId,
      quoteId,
      buffer: pdfBuffer,
      filename: pdfFilename,
      mimeType: 'application/pdf',
      kind: 'quote_pdf',
      user,
    });

    // If we fell back from quote-hybrid to a single-type template,
    // surface that in the flash so the user knows why their hybrid
    // quote rendered as a Spares (or Service, etc) document.
    if (usedFallback) {
      return redirect(
        `${returnTo}?highlight=${docId}&flash=${encodeURIComponent(
          'Hybrid template not yet uploaded — rendered with the primary type\u2019s template.'
        )}&flash_kind=warn`
      );
    }
    return redirect(`${returnTo}?highlight=${docId}`);
  } catch (err) {
    console.error('PDF generation failed:', err);
    return redirectWithFlash(returnTo, `PDF generation failed: ${err.message}`, 'error');
  }
}
