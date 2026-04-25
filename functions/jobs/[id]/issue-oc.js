// functions/jobs/[id]/issue-oc.js
//
// POST /jobs/:id/issue-oc — Capture OC number and issue the Order Confirmation.
//
// For spares/service: status → handed_off (OC is the final step).
// For eps: status → awaiting_authorization (need customer auth before NTP).
// For refurb: status → handed_off (baseline OC).
//
// Also advances the parent opportunity's stage to 'oc_issued' (if it
// isn't already there) and fires oc.issued + job.handed_off (non-EPS)
// + opportunity.stage_changed auto-task events so downstream rules
// (e.g. "Notify Finance to send initial invoice") can create tasks.

import { one, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { now } from '../../lib/ids.js';
import { redirectWithFlash, formBody } from '../../lib/http.js';
import { fireEvent, reportError } from '../../lib/auto-tasks.js';
import { changeOppStage } from '../../lib/stage-transitions.js';
import {
  getOcDocData,
  resolveOcTemplateKey,
  renderPdfOrPlaceholder,
} from '../../lib/doc-generate.js';
import { storeGeneratedDoc } from '../../lib/doc-storage.js';
import {
  getFilenameTemplate,
  renderFilenameTemplate,
} from '../../lib/filename-templates.js';
import { templateTypeForOC } from '../../lib/template-catalog.js';

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const jobId = params.id;

  const job = await one(env.DB, 'SELECT * FROM jobs WHERE id = ?', [jobId]);
  if (!job) return redirectWithFlash('/jobs', 'Job not found.', 'error');

  if (job.oc_issued_at) {
    return redirectWithFlash(
      `/jobs/${jobId}/oc`,
      'OC has already been issued. Revise to bump the revision before re-issuing.',
      'error'
    );
  }

  const input = await formBody(request);
  const ocNumber = (input.oc_number || '').trim();
  if (!ocNumber) {
    return redirectWithFlash(`/jobs/${jobId}`, 'OC number is required.', 'error');
  }

  const ts = now();
  const customerPo = (input.customer_po_number || '').trim() || job.customer_po_number;

  // Determine next status based on job type
  let newStatus;
  if ((job.job_type || '').split(',').includes('eps')) {
    newStatus = 'awaiting_authorization';
  } else {
    // spares, refurb, service — OC means handed off
    newStatus = 'handed_off';
  }

  // Load parent opp for downstream event payloads. Stage advance is
  // handled below via changeOppStage — we never write the dead
  // `oc_issued` key directly anymore (see migration 0041).
  const opp = job.opportunity_id
    ? await one(env.DB, 'SELECT * FROM opportunities WHERE id = ?', [job.opportunity_id])
    : null;

  await batch(env.DB, [
    stmt(env.DB,
      `UPDATE jobs
          SET oc_number = ?, oc_issued_at = ?, oc_issued_by_user_id = ?,
              customer_po_number = ?, status = ?,
              ${newStatus === 'handed_off' ? 'handed_off_at = ?, handed_off_by_user_id = ?,' : ''}
              updated_at = ?
        WHERE id = ?`,
      [
        ocNumber, ts, user?.id,
        customerPo, newStatus,
        ...(newStatus === 'handed_off' ? [ts, user?.id] : []),
        ts, jobId,
      ]),
    auditStmt(env.DB, {
      entityType: 'job',
      entityId: jobId,
      eventType: 'oc_issued',
      user,
      summary: `OC issued: ${ocNumber} — status → ${newStatus}`,
      changes: {
        oc_number: { from: job.oc_number, to: ocNumber },
        status: { from: job.status, to: newStatus },
      },
    }),
  ]);

  // Advance the opp to `oc_drafted` (intermediate — OC is out in the
  // world, task pending to formally submit it to the customer). The
  // helper's onlyForward guard skips regression for opps already past
  // this point (e.g. revisited OCs). Task completion then advances
  // to `oc_submitted` via advanceStageOnTaskComplete.
  if (opp) {
    await changeOppStage(context, opp.id, 'oc_drafted', {
      reason: `OC ${ocNumber} issued`,
      onlyForward: true,
    });
  }

  // Auto-task fan-out. Non-blocking so a rule-engine failure never
  // rolls back a successful OC issuance.
  context.waitUntil(
    (async () => {
      try {
        const [freshJob, freshOpp, account] = await Promise.all([
          one(env.DB, 'SELECT * FROM jobs WHERE id = ?', [jobId]),
          opp
            ? one(env.DB, 'SELECT * FROM opportunities WHERE id = ?', [opp.id])
            : null,
          opp
            ? one(env.DB,
                `SELECT a.* FROM accounts a
                   JOIN opportunities o ON o.account_id = a.id
                  WHERE o.id = ?`,
                [opp.id])
            : null,
        ]);
        const payloadBase = {
          trigger: { user, at: ts },
          job: freshJob,
          opportunity: freshOpp,
          account,
        };

        await fireEvent(env, 'oc.issued', payloadBase, user);

        // Spares / refurb / service: the job also handed off at this
        // moment. EPS stays in awaiting_authorization and will fire
        // handed_off later from issue-ntp.js.
        if (newStatus === 'handed_off') {
          await fireEvent(env, 'job.handed_off', payloadBase, user);
        }

        // opportunity.stage_changed is fired inside changeOppStage
        // (above), so we don't re-fire it here.
      } catch (err) {
        console.error('fireEvent(oc.issued) failed:', err?.message || err);
      }
    })()
  );

  // Auto-generate the OC PDF synchronously so the browser downloads
  // it as part of this redirect. Failures are logged (and reported to
  // the auto-task error pipeline) but never roll back the OC issuance.
  let downloadDocId = null;
  try {
    const docData = await getOcDocData(env, jobId);
    if (docData) {
      const jobType = (job.job_type || '').split(',')[0].trim();
      const { key: templateKey } = await resolveOcTemplateKey(env, jobType);

      const filenameKey = templateTypeForOC(jobType);
      const fnTpl = await getFilenameTemplate(
        env,
        filenameKey,
        'C-LARS OC {ocNumber}'
      );
      const fnCtx = {
        ocNumber,
        jobNumber: job.number,
        opportunityNumber: docData.opportunityNumber || docData._number || '',
        accountName: docData.clientName || '',
        accountAlias: docData.clientAlias || '',
      };
      const pdfFilename =
        (renderFilenameTemplate(fnTpl, fnCtx) || `OC-${ocNumber}`) + '.pdf';

      const { buffer: pdfBuffer, isPlaceholder } =
        await renderPdfOrPlaceholder(env, templateKey, docData, filenameKey);
      downloadDocId = await storeGeneratedDoc(env, {
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
    }
  } catch (err) {
    console.error('Auto OC PDF generation failed:', err);
    context.waitUntil(
      reportError(env, 'oc_pdf_generation_failed', {
        summary: `Auto OC PDF failed for job ${job.number} (OC ${ocNumber})`,
        detail: err?.message || String(err),
        context: { jobId, job_type: job.job_type, oc_number: ocNumber },
        user,
      }).catch(() => {})
    );
  }

  const msg = newStatus === 'handed_off'
    ? `OC ${ocNumber} issued — job handed off.`
    : `OC ${ocNumber} issued — awaiting customer authorization.`;

  const redirectUrl = downloadDocId
    ? `/jobs/${jobId}/oc?highlight=${encodeURIComponent(downloadDocId)}`
    : `/jobs/${jobId}/oc`;
  return redirectWithFlash(redirectUrl, msg);
}
