// functions/jobs/[id]/generate-oc-pdf.js
//
// POST /jobs/:id/generate-oc-pdf — Render an OC PDF on demand and
// store it on the job. Mirrors /opportunities/:id/quotes/:quoteId/
// generate-pdf — does not change the OC's lifecycle, just produces a
// fresh document from the current data.

import { one } from '../../lib/db.js';
import { redirect, redirectWithFlash } from '../../lib/http.js';
import {
  getOcDocData,
  resolveOcTemplateKey,
  renderPdfOrPlaceholder,
} from '../../lib/doc-generate.js';
import { storeGeneratedDoc } from '../../lib/doc-storage.js';
import { templateTypeForOC } from '../../lib/template-catalog.js';
import {
  getFilenameTemplate,
  renderFilenameTemplate,
} from '../../lib/filename-templates.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const jobId = params.id;
  const returnTo = `/jobs/${jobId}/oc`;

  const job = await one(env.DB, 'SELECT * FROM jobs WHERE id = ?', [jobId]);
  if (!job) return redirectWithFlash('/jobs', 'Job not found.', 'error');

  try {
    const docData = await getOcDocData(env, jobId);
    if (!docData) {
      return redirectWithFlash(returnTo, 'No accepted quote to source the OC from.', 'error');
    }

    const jobType = (job.job_type || '').split(',')[0].trim();
    const { key: templateKey } = await resolveOcTemplateKey(env, jobType);
    const filenameKey = templateTypeForOC(jobType);
    const fnTpl = await getFilenameTemplate(
      env,
      filenameKey,
      'C-LARS OC {ocNumber}'
    );
    const fnCtx = {
      ocNumber: job.oc_number || '',
      jobNumber: job.number,
      opportunityNumber: docData.opportunityNumber || '',
      accountName: docData.clientName || '',
      accountAlias: docData.clientAlias || '',
    };
    const pdfFilename =
      (renderFilenameTemplate(fnTpl, fnCtx) || `OC-${job.oc_number || job.number}`) + '.pdf';

    const { buffer: pdfBuffer, isPlaceholder } =
      await renderPdfOrPlaceholder(env, templateKey, docData, filenameKey);
    const docId = await storeGeneratedDoc(env, {
      opportunityId: job.opportunity_id,
      jobId,
      buffer: pdfBuffer,
      filename: isPlaceholder
        ? pdfFilename.replace(/\.pdf$/, ' (placeholder).pdf')
        : pdfFilename,
      mimeType: 'application/pdf',
      kind: 'oc_pdf',
      user,
    });

    // Form on the job-OC page submits with target="_blank" — open the
    // generated PDF inline in the new tab. Doc is still stored on the
    // job so it shows in the docs list on next page load.
    return redirect(`/documents/${docId}/download`);
  } catch (err) {
    console.error('OC PDF generation failed:', err);
    return redirectWithFlash(returnTo, `PDF generation failed: ${err.message}`, 'error');
  }
}
