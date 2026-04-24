// functions/jobs/[id]/change-orders/[coId]/issue-amended-oc.js
//
// POST /jobs/:id/change-orders/:coId/issue-amended-oc
// Issue the Amended Order Confirmation for an accepted change order.
//
// Writes amended_oc_* fields onto the change_orders row, fires
// `change_order.amended_oc_issued` which triggers the seeded submit-
// task rule, advances the opp to `amended_oc_drafted`, and emits the
// amended OC PDF.

import { one, stmt, batch } from '../../../../lib/db.js';
import { auditStmt } from '../../../../lib/audit.js';
import { now } from '../../../../lib/ids.js';
import { redirectWithFlash, formBody } from '../../../../lib/http.js';
import { fireEvent, reportError } from '../../../../lib/auto-tasks.js';
import { changeOppStage } from '../../../../lib/stage-transitions.js';
import { getOcDocData, renderPdfOrPlaceholder } from '../../../../lib/doc-generate.js';
import { storeGeneratedDoc } from '../../../../lib/doc-storage.js';
import {
  getFilenameTemplate,
  renderFilenameTemplate,
} from '../../../../lib/filename-templates.js';

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const jobId = params.id;
  const coId = params.coId;

  const co = await one(
    env.DB,
    `SELECT co.*, j.number AS job_number, j.opportunity_id AS job_opp_id
       FROM change_orders co
       LEFT JOIN jobs j ON j.id = co.job_id
      WHERE co.id = ? AND co.job_id = ?`,
    [coId, jobId]
  );
  if (!co) return redirectWithFlash(`/jobs/${jobId}`, 'CO not found.', 'error');
  if (co.status !== 'won') {
    return redirectWithFlash(
      `/jobs/${jobId}/change-orders/${coId}`,
      'Amended OC can only be issued after the CO is accepted.',
      'error'
    );
  }

  const input = await formBody(request);
  const amendedOcNumber = (input.amended_oc_number || '').trim();
  if (!amendedOcNumber) {
    return redirectWithFlash(
      `/jobs/${jobId}/change-orders/${coId}`,
      'Amended OC number is required.',
      'error'
    );
  }

  const ts = now();
  const notes = (input.notes || '').trim() || null;
  const newRev = co.amended_oc_revision || 1;

  await batch(env.DB, [
    stmt(env.DB,
      `UPDATE change_orders
          SET amended_oc_number = ?,
              amended_oc_revision = ?,
              amended_oc_issued_at = ?,
              amended_oc_issued_by_user_id = ?,
              updated_at = ?
        WHERE id = ?`,
      [amendedOcNumber, newRev, ts, user?.id ?? null, ts, coId]),
    auditStmt(env.DB, {
      entityType: 'change_order',
      entityId: coId,
      eventType: 'amended_oc_issued',
      user,
      summary: `Amended OC issued: ${amendedOcNumber} (rev ${newRev})${notes ? ` — ${notes}` : ''}`,
      changes: {
        amended_oc_number: { from: co.amended_oc_number, to: amendedOcNumber },
        amended_oc_revision: { from: co.amended_oc_revision, to: newRev },
      },
    }),
  ]);

  // Advance opp to amended_oc_drafted — submit task is pending, task
  // completion will carry it to amended_oc_submitted.
  if (co.opportunity_id) {
    await changeOppStage(context, co.opportunity_id, 'amended_oc_drafted', {
      reason: `Amended OC ${amendedOcNumber} issued (CO ${co.number})`,
      onlyForward: true,
    });
  }

  context.waitUntil(
    (async () => {
      try {
        const [freshCo, job, opportunity, account] = await Promise.all([
          one(env.DB, 'SELECT * FROM change_orders WHERE id = ?', [coId]),
          one(env.DB, 'SELECT * FROM jobs WHERE id = ?', [jobId]),
          co.opportunity_id
            ? one(env.DB, 'SELECT * FROM opportunities WHERE id = ?', [co.opportunity_id])
            : null,
          co.opportunity_id
            ? one(env.DB,
                `SELECT a.* FROM accounts a
                   JOIN opportunities o ON o.account_id = a.id
                  WHERE o.id = ?`,
                [co.opportunity_id])
            : null,
        ]);
        await fireEvent(env, 'change_order.amended_oc_issued', {
          trigger: { user, at: ts },
          change_order: freshCo,
          job,
          opportunity,
          account,
        }, user);
      } catch (err) {
        console.error(
          'fireEvent(change_order.amended_oc_issued) failed:',
          err?.message || err
        );
      }
    })()
  );

  // Auto-generate the amended OC PDF using the universal `oc-amended`
  // template. Placeholder path in renderPdfOrPlaceholder covers the
  // "template not yet uploaded" case.
  let downloadDocId = null;
  try {
    const docData = await getOcDocData(env, jobId);
    if (docData) {
      const amendedData = {
        ...docData,
        amendedOcNumber,
        AmendedOcNumber: amendedOcNumber,
        amendedOcDate: ts.slice(0, 10),
        AmendedOcDate: ts.slice(0, 10),
        amendedOcRevision: newRev,
        AmendedOcRevision: newRev,
        changeOrderNumber: co.number,
        ChangeOrderNumber: co.number,
      };
      const templateKey = 'templates/oc-amended.docx';
      const filenameKey = 'oc-amended';
      const fnTpl = await getFilenameTemplate(
        env,
        filenameKey,
        'C-LARS Amended OC {amendedOcNumber}'
      );
      const fnCtx = {
        amendedOcNumber,
        jobNumber: co.job_number,
        changeOrderNumber: co.number,
        opportunityNumber: amendedData.opportunityNumber || '',
        accountName: amendedData.clientName || '',
        accountAlias: amendedData.clientAlias || '',
      };
      const pdfFilename =
        (renderFilenameTemplate(fnTpl, fnCtx) ||
          `Amended-OC-${amendedOcNumber}`) + '.pdf';

      const { buffer: pdfBuffer, isPlaceholder } =
        await renderPdfOrPlaceholder(env, templateKey, amendedData, filenameKey);
      downloadDocId = await storeGeneratedDoc(env, {
        opportunityId: co.opportunity_id,
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
    console.error('Amended OC PDF generation failed:', err);
    context.waitUntil(
      reportError(env, 'amended_oc_pdf_generation_failed', {
        summary: `Amended OC PDF failed for CO ${co.number}`,
        detail: err?.message || String(err),
        context: { jobId, coId, amended_oc_number: amendedOcNumber },
        user,
      }).catch(() => {})
    );
  }

  const redirectUrl = downloadDocId
    ? `/jobs/${jobId}/change-orders/${coId}?download=${encodeURIComponent(downloadDocId)}`
    : `/jobs/${jobId}/change-orders/${coId}`;
  return redirectWithFlash(
    redirectUrl,
    `Amended OC ${amendedOcNumber} issued — task created to submit to customer.`
  );
}
