// functions/jobs/[id]/issue-inspection-report.js
//
// POST /jobs/:id/issue-inspection-report — Refurb only.
// Marks the inspection report as issued and fires
// `inspection_report.issued` so the seeded auto-task rule creates a
// "Submit inspection report to customer" task. When that task is
// marked complete, advanceStageOnTaskComplete() advances the parent
// opportunity to the `inspection_report_submitted` stage.
//
// Inspection reports don't have a drafted/issued/submitted split
// like quotes and OCs — they're produced after teardown and issued
// once. The refurb stage catalog reflects that: only a single
// `inspection_report_submitted` stage (migration 0041, refurb slot 11)
// which we reach via the task completion, not this endpoint.

import { one, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { now } from '../../lib/ids.js';
import { redirectWithFlash } from '../../lib/http.js';
import { fireEvent, reportError } from '../../lib/auto-tasks.js';
import { getOcDocData, renderPdfOrPlaceholder } from '../../lib/doc-generate.js';
import { storeGeneratedDoc } from '../../lib/doc-storage.js';
import {
  getFilenameTemplate,
  renderFilenameTemplate,
} from '../../lib/filename-templates.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const jobId = params.id;

  const job = await one(env.DB, 'SELECT * FROM jobs WHERE id = ?', [jobId]);
  if (!job) return redirectWithFlash('/jobs', 'Job not found.', 'error');

  if (!(job.job_type || '').split(',').includes('refurb')) {
    return redirectWithFlash(
      `/jobs/${jobId}`,
      'Inspection reports are only applicable to refurb jobs.',
      'error'
    );
  }
  if (job.status !== 'handed_off') {
    return redirectWithFlash(
      `/jobs/${jobId}`,
      'Inspection report can only be issued after job hand-off.',
      'error'
    );
  }
  if (job.inspection_report_issued_at) {
    return redirectWithFlash(
      `/jobs/${jobId}`,
      'Inspection report has already been issued for this job.',
      'error'
    );
  }

  const ts = now();

  await batch(env.DB, [
    stmt(env.DB,
      `UPDATE jobs
          SET inspection_report_issued_at = ?,
              inspection_report_issued_by_user_id = ?,
              updated_at = ?
        WHERE id = ?`,
      [ts, user?.id ?? null, ts, jobId]),
    auditStmt(env.DB, {
      entityType: 'job',
      entityId: jobId,
      eventType: 'inspection_report_issued',
      user,
      summary: `Inspection report issued for ${job.number}`,
      changes: {
        inspection_report_issued_at: { from: null, to: ts },
      },
    }),
  ]);

  // Fan out — creates the "Submit inspection report to customer" task
  // on the opportunity owner via the seeded rule.
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
        await fireEvent(env, 'inspection_report.issued', {
          trigger: { user, at: ts },
          job: freshJob,
          opportunity,
          account,
        }, user);
      } catch (err) {
        console.error(
          'fireEvent(inspection_report.issued) failed:',
          err?.message || err
        );
      }
    })()
  );

  // Auto-generate the inspection report PDF. The dedicated
  // `inspection-report-refurb` template probably isn't uploaded yet;
  // the placeholder path in renderPdfOrPlaceholder covers that so the
  // download flow still delivers something.
  let downloadDocId = null;
  try {
    // Reuse the OC doc data as the base payload — it already pulls job
    // + opportunity + account + the most-recent accepted/issued quote
    // which is exactly what an inspection report template needs.
    const docData = await getOcDocData(env, jobId);
    const payload = {
      ...(docData || {}),
      jobNumber: job.number,
      inspectionReportDate: ts.slice(0, 10),
      InspectionReportDate: ts.slice(0, 10),
    };
    const templateKey = 'templates/inspection-report-refurb.docx';
    const filenameKey = 'inspection-report-refurb';
    const fnTpl = await getFilenameTemplate(
      env,
      filenameKey,
      'C-LARS Inspection Report {jobNumber}'
    );
    const fnCtx = {
      jobNumber: job.number,
      opportunityNumber: payload.opportunityNumber || '',
      accountName: payload.clientName || '',
      accountAlias: payload.clientAlias || '',
    };
    const pdfFilename =
      (renderFilenameTemplate(fnTpl, fnCtx) ||
        `Inspection-Report-${job.number}`) + '.pdf';

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
      kind: 'inspection_report',
      user,
    });
  } catch (err) {
    console.error('Inspection report PDF generation failed:', err);
    context.waitUntil(
      reportError(env, 'inspection_report_pdf_generation_failed', {
        summary: `Inspection report PDF failed for job ${job.number}`,
        detail: err?.message || String(err),
        context: { jobId },
        user,
      }).catch(() => {})
    );
  }

  const redirectUrl = downloadDocId
    ? `/jobs/${jobId}?download=${encodeURIComponent(downloadDocId)}`
    : `/jobs/${jobId}`;
  return redirectWithFlash(
    redirectUrl,
    'Inspection report issued — task created to submit to customer.'
  );
}
