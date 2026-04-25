// functions/jobs/[id]/generate-ntp-docx.js
//
// POST /jobs/:id/generate-ntp-docx — Render an NTP Word document on
// demand and store it on the job. Mirrors generate-oc-docx for NTP.

import { one } from '../../lib/db.js';
import { redirect, redirectWithFlash } from '../../lib/http.js';
import {
  getOcDocData,
  fillTemplate,
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
    const docxBuffer = await fillTemplate(env, templateKey, payload);

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
    const docxFilename =
      (renderFilenameTemplate(fnTpl, fnCtx) ||
        `NTP-${job.ntp_number || job.number}`) + '.docx';

    const docId = await storeGeneratedDoc(env, {
      opportunityId: job.opportunity_id,
      jobId,
      buffer: docxBuffer,
      filename: docxFilename,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      kind: 'ntp_docx',
      user,
    });

    return redirect(`${returnTo}?highlight=${docId}`);
  } catch (err) {
    console.error('NTP DOCX generation failed:', err);
    return redirectWithFlash(returnTo, `Word generation failed: ${err.message}`, 'error');
  }
}
