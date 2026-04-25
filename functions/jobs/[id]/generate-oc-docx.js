// functions/jobs/[id]/generate-oc-docx.js
//
// POST /jobs/:id/generate-oc-docx — Render an OC Word document on
// demand and store it on the job. Mirrors /opportunities/:id/quotes/
// :quoteId/generate-docx — no PDF conversion, just the .docx.

import { one } from '../../lib/db.js';
import { redirect, redirectWithFlash } from '../../lib/http.js';
import {
  getOcDocData,
  resolveOcTemplateKey,
  fillTemplate,
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
    const docxBuffer = await fillTemplate(env, templateKey, docData);

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
    const docxFilename =
      (renderFilenameTemplate(fnTpl, fnCtx) || `OC-${job.oc_number || job.number}`) + '.docx';

    const docId = await storeGeneratedDoc(env, {
      opportunityId: job.opportunity_id,
      jobId,
      buffer: docxBuffer,
      filename: docxFilename,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      kind: 'oc_docx',
      user,
    });

    return redirect(`${returnTo}?highlight=${docId}`);
  } catch (err) {
    console.error('OC DOCX generation failed:', err);
    return redirectWithFlash(returnTo, `Word generation failed: ${err.message}`, 'error');
  }
}
