// functions/jobs/[id]/generate-ntp-pdf.js
//
// POST /jobs/:id/generate-ntp-pdf — Render an NTP PDF on demand and
// store it on the job. Mirrors generate-oc-pdf for the NTP path.

import { one } from '../../lib/db.js';
import { redirect, redirectWithFlash } from '../../lib/http.js';
import {
  getOcDocData,
  renderPdfOrPlaceholder,
} from '../../lib/doc-generate.js';
import { storeGeneratedDoc } from '../../lib/doc-storage.js';
import {
  getFilenameTemplate,
  renderFilenameTemplate,
} from '../../lib/filename-templates.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const jobId = params.id;
  const returnTo = `/jobs/${jobId}/ntp`;

  const job = await one(env.DB, 'SELECT * FROM jobs WHERE id = ?', [jobId]);
  if (!job) return redirectWithFlash('/jobs', 'Job not found.', 'error');

  if (!(job.job_type || '').split(',').includes('eps')) {
    return redirectWithFlash(returnTo, 'NTP is only applicable to EPS jobs.', 'error');
  }

  try {
    const docData = await getOcDocData(env, jobId);
    if (!docData) {
      return redirectWithFlash(returnTo, 'No accepted quote to source the NTP from.', 'error');
    }
    const ts = (job.ntp_issued_at || '').slice(0, 10);
    const payload = {
      ...docData,
      ntpNumber: job.ntp_number || '',
      NtpNumber: job.ntp_number || '',
      ntpDate: ts,
      NtpDate: ts,
      jobNumber: job.number,
    };
    const templateKey = 'templates/ntp.docx';
    const filenameKey = 'ntp';
    const fnTpl = await getFilenameTemplate(
      env,
      filenameKey,
      'C-LARS NTP {ntpNumber}'
    );
    const fnCtx = {
      ntpNumber: job.ntp_number || job.number,
      jobNumber: job.number,
      opportunityNumber: payload.opportunityNumber || '',
      accountName: payload.clientName || '',
      accountAlias: payload.clientAlias || '',
    };
    const pdfFilename =
      (renderFilenameTemplate(fnTpl, fnCtx) ||
        `NTP-${job.ntp_number || job.number}`) + '.pdf';

    const { buffer: pdfBuffer, isPlaceholder } =
      await renderPdfOrPlaceholder(env, templateKey, payload, filenameKey);
    const docId = await storeGeneratedDoc(env, {
      opportunityId: job.opportunity_id,
      jobId,
      buffer: pdfBuffer,
      filename: isPlaceholder
        ? pdfFilename.replace(/\.pdf$/, ' (placeholder).pdf')
        : pdfFilename,
      mimeType: 'application/pdf',
      kind: 'ntp_pdf',
      user,
    });

    return redirect(`${returnTo}?highlight=${docId}`);
  } catch (err) {
    console.error('NTP PDF generation failed:', err);
    return redirectWithFlash(returnTo, `PDF generation failed: ${err.message}`, 'error');
  }
}
