// functions/jobs/[id]/issue-ntp.js
//
// POST /jobs/:id/issue-ntp — EPS only.
// Issues Notice to Proceed. Status: awaiting_ntp → handed_off.

import { one, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { now } from '../../lib/ids.js';
import { redirectWithFlash, formBody } from '../../lib/http.js';
import { fireEvent, reportError } from '../../lib/auto-tasks.js';
import { changeOppStage } from '../../lib/stage-transitions.js';
import { getOcDocData, renderPdfOrPlaceholder } from '../../lib/doc-generate.js';
import { storeGeneratedDoc } from '../../lib/doc-storage.js';
import {
  getFilenameTemplate,
  renderFilenameTemplate,
} from '../../lib/filename-templates.js';

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const jobId = params.id;

  const job = await one(env.DB, 'SELECT * FROM jobs WHERE id = ?', [jobId]);
  if (!job) return redirectWithFlash('/jobs', 'Job not found.', 'error');

  if (!(job.job_type || '').split(',').includes('eps')) {
    return redirectWithFlash(`/jobs/${jobId}`, 'NTP is only applicable to EPS jobs.', 'error');
  }
  if (job.status !== 'awaiting_ntp') {
    return redirectWithFlash(`/jobs/${jobId}`, 'Job is not awaiting NTP.', 'error');
  }

  const input = await formBody(request);
  const ts = now();
  const ntpNumber = (input.ntp_number || '').trim() || null;

  await batch(env.DB, [
    stmt(env.DB,
      `UPDATE jobs
          SET ntp_number = ?, ntp_issued_at = ?, ntp_issued_by_user_id = ?,
              status = 'handed_off',
              handed_off_at = ?, handed_off_by_user_id = ?,
              updated_at = ?
        WHERE id = ?`,
      [ntpNumber, ts, user?.id, ts, user?.id, ts, jobId]),
    auditStmt(env.DB, {
      entityType: 'job',
      entityId: jobId,
      eventType: 'ntp_issued',
      user,
      summary: `NTP issued${ntpNumber ? `: ${ntpNumber}` : ''} — job handed off`,
      changes: {
        status: { from: 'awaiting_ntp', to: 'handed_off' },
        ntp_number: { from: null, to: ntpNumber },
      },
    }),
  ]);

  // Advance parent opp to `ntp_drafted` — intermediate stage during
  // which the "Submit NTP to customer" task is pending. Task completion
  // advances to `ntp_submitted` via advanceStageOnTaskComplete.
  // onlyForward guards against regressing already-advanced opps.
  if (job.opportunity_id) {
    await changeOppStage(context, job.opportunity_id, 'ntp_drafted', {
      reason: `NTP ${ntpNumber || ''} issued`,
      onlyForward: true,
    });
  }

  // EPS-only handoff. Fire ntp.issued and job.handed_off so auto-task
  // rules can react. Non-blocking.
  context.waitUntil(
    (async () => {
      try {
        const [freshJob, opportunity, account] = await Promise.all([
          one(env.DB, 'SELECT * FROM jobs WHERE id = ?', [jobId]),
          job.opportunity_id
            ? one(env.DB, 'SELECT * FROM opportunities WHERE id = ?', [job.opportunity_id])
            : null,
          job.opportunity_id
            ? one(env.DB,
                `SELECT a.* FROM accounts a
                   JOIN opportunities o ON o.account_id = a.id
                  WHERE o.id = ?`,
                [job.opportunity_id])
            : null,
        ]);
        const payload = {
          trigger: { user, at: ts },
          job: freshJob,
          opportunity,
          account,
        };
        await fireEvent(env, 'ntp.issued', payload, user);
        await fireEvent(env, 'job.handed_off', payload, user);
      } catch (err) {
        console.error('fireEvent(ntp.issued) failed:', err?.message || err);
      }
    })()
  );

  // Auto-generate the NTP PDF. The `ntp` template probably isn't
  // uploaded yet — placeholder fallback keeps the download flow
  // working end-to-end.
  let downloadDocId = null;
  try {
    const docData = await getOcDocData(env, jobId);
    const payload = {
      ...(docData || {}),
      ntpNumber: ntpNumber || '',
      NtpNumber: ntpNumber || '',
      ntpDate: ts.slice(0, 10),
      NtpDate: ts.slice(0, 10),
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
      ntpNumber: ntpNumber || job.number,
      jobNumber: job.number,
      opportunityNumber: payload.opportunityNumber || '',
      accountName: payload.clientName || '',
      accountAlias: payload.clientAlias || '',
    };
    const pdfFilename =
      (renderFilenameTemplate(fnTpl, fnCtx) ||
        `NTP-${ntpNumber || job.number}`) + '.pdf';

    const { buffer: pdfBuffer, isPlaceholder } =
      await renderPdfOrPlaceholder(env, templateKey, payload, filenameKey);
    downloadDocId = await storeGeneratedDoc(env, {
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
  } catch (err) {
    console.error('NTP PDF generation failed:', err);
    context.waitUntil(
      reportError(env, 'ntp_pdf_generation_failed', {
        summary: `NTP PDF failed for job ${job.number}`,
        detail: err?.message || String(err),
        context: { jobId, ntp_number: ntpNumber },
        user,
      }).catch(() => {})
    );
  }

  const redirectUrl = downloadDocId
    ? `/jobs/${jobId}?download=${encodeURIComponent(downloadDocId)}`
    : `/jobs/${jobId}`;
  return redirectWithFlash(
    redirectUrl,
    `NTP${ntpNumber ? ` ${ntpNumber}` : ''} issued — job handed off.`
  );
}
