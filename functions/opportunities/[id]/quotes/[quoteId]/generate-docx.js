// POST /opportunities/:id/quotes/:quoteId/generate-docx
//
// Generate a filled .docx from the quote template and store in R2.
// No PDF conversion — for when the user just needs the Word doc.

import { one } from '../../../../lib/db.js';
import { redirect, redirectWithFlash } from '../../../../lib/http.js';
import {
  getQuoteDocData,
  fillTemplate,
  resolveQuoteTemplateKey,
} from '../../../../lib/doc-generate.js';
import { storeGeneratedDoc } from '../../../../lib/doc-storage.js';
import { templateTypeForQuote } from '../../../../lib/template-catalog.js';
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

  const quote = await one(env.DB, 'SELECT id, opportunity_id, quote_type, number, revision, title FROM quotes WHERE id = ?', [quoteId]);
  if (!quote || quote.opportunity_id !== oppId) {
    return new Response('Quote not found', { status: 404 });
  }

  try {
    const docData = await getQuoteDocData(env, quoteId);
    if (!docData) {
      return redirectWithFlash(returnTo, 'Could not load quote data.', 'error');
    }

    // Hybrid quotes try the quote-hybrid.docx template first; fall
    // back to the primary type's single-type template if the hybrid
    // one hasn't been uploaded yet.
    const { key: templateKey, usedFallback } =
      await resolveQuoteTemplateKey(env, quote.quote_type);
    const docxBuffer = await fillTemplate(env, templateKey, docData);

    // Build the download filename from the admin-configurable
    // template keyed by the "ideal" template catalog key (e.g.
    // quote-hybrid even when the R2 fallback kicks in). The stored
    // template doesn't include the extension — we append `.docx`
    // here so one convention covers both PDF and Word downloads.
    const fnCtx = buildQuoteFilenameContext({
      quote,
      accountName:       docData.clientName,
      accountAlias:      docData.clientAlias,
      opportunityNumber: docData.opportunityNumber,
      opportunityTitle:  docData.opportunityTitle,
    });
    const filenameKey = templateTypeForQuote(quote.quote_type);
    const fnTpl = await getFilenameTemplate(
      env,
      filenameKey,
      'C-LARS Quote {quoteNumber}{revisionSuffix}'
    );
    const docxFilename =
      (renderFilenameTemplate(fnTpl, fnCtx) ||
        `${quote.number}${fnCtx.revisionSuffix}`) + '.docx';

    const docId = await storeGeneratedDoc(env, {
      opportunityId: oppId,
      quoteId,
      buffer: docxBuffer,
      filename: docxFilename,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      kind: 'quote_docx',
      user,
    });

    if (usedFallback) {
      return redirect(
        `${returnTo}?highlight=${docId}&flash=${encodeURIComponent(
          'Hybrid template not yet uploaded — rendered with the primary type\u2019s template.'
        )}&flash_kind=warn`
      );
    }
    // Success → open the generated .docx in a new tab. Browsers
    // typically prompt to open in Word (or download and open) since
    // .docx isn't a renderable inline type. Form on the quote-detail
    // page submits with target="_blank" so the original tab stays put.
    return redirect(`/documents/${docId}/download`);
  } catch (err) {
    console.error('DOCX generation failed:', err);
    return redirectWithFlash(returnTo, `Word generation failed: ${err.message}`, 'error');
  }
}
