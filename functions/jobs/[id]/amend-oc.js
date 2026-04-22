// functions/jobs/[id]/amend-oc.js
//
// POST /jobs/:id/amend-oc — Refurb only.
// Issues an Amended Order Confirmation after a supplemental quote has
// been accepted. The amended OC supersedes the baseline OC and
// authorizes commencement of the modified scope (governance §4.3).
//
// Writes to the jobs.amended_oc_* columns (not the baseline oc_* set)
// so both histories are preserved. Fires `amended_oc.issued` which
// triggers the seeded auto-task rule to create a "Submit amended OC
// to customer" task. Also advances the opp to `amended_oc_drafted`
// immediately; task complete → `amended_oc_submitted`.
//
// Job status stays at `handed_off` — the amended OC is a commercial
// document, not a job-state change.

import { one, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { now } from '../../lib/ids.js';
import { redirectWithFlash, formBody } from '../../lib/http.js';
import { fireEvent } from '../../lib/auto-tasks.js';
import { changeOppStage } from '../../lib/stage-transitions.js';

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const jobId = params.id;

  const job = await one(env.DB, 'SELECT * FROM jobs WHERE id = ?', [jobId]);
  if (!job) return redirectWithFlash('/jobs', 'Job not found.', 'error');

  if (!(job.job_type || '').split(',').includes('refurb')) {
    return redirectWithFlash(
      `/jobs/${jobId}`,
      'OC amendments are only applicable to refurb jobs.',
      'error'
    );
  }
  if (job.status !== 'handed_off') {
    return redirectWithFlash(
      `/jobs/${jobId}`,
      'OC can only be amended after hand-off.',
      'error'
    );
  }

  const input = await formBody(request);
  const amendedOcNumber = (input.amended_oc_number || input.oc_number || '').trim();
  if (!amendedOcNumber) {
    return redirectWithFlash(
      `/jobs/${jobId}`,
      'Amended OC number is required.',
      'error'
    );
  }

  const ts = now();
  const notes = (input.notes || '').trim() || null;
  const newRev = (job.amended_oc_revision || 1);

  await batch(env.DB, [
    stmt(env.DB,
      `UPDATE jobs
          SET amended_oc_number = ?,
              amended_oc_revision = ?,
              amended_oc_issued_at = ?,
              amended_oc_issued_by_user_id = ?,
              updated_at = ?
        WHERE id = ?`,
      [amendedOcNumber, newRev, ts, user?.id ?? null, ts, jobId]),
    auditStmt(env.DB, {
      entityType: 'job',
      entityId: jobId,
      eventType: 'amended_oc_issued',
      user,
      summary: `Amended OC issued: ${amendedOcNumber} (rev ${newRev})${notes ? ` — ${notes}` : ''}`,
      changes: {
        amended_oc_number: { from: job.amended_oc_number, to: amendedOcNumber },
        amended_oc_revision: { from: job.amended_oc_revision, to: newRev },
      },
    }),
  ]);

  // Advance opp to `amended_oc_drafted` — submit task is pending,
  // task completion will carry it to `amended_oc_submitted`.
  if (job.opportunity_id) {
    await changeOppStage(context, job.opportunity_id, 'amended_oc_drafted', {
      reason: `Amended OC ${amendedOcNumber} issued`,
      onlyForward: true,
    });
  }

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
        await fireEvent(env, 'amended_oc.issued', {
          trigger: { user, at: ts },
          job: freshJob,
          opportunity,
          account,
        }, user);
      } catch (err) {
        console.error(
          'fireEvent(amended_oc.issued) failed:',
          err?.message || err
        );
      }
    })()
  );

  return redirectWithFlash(
    `/jobs/${jobId}`,
    `Amended OC ${amendedOcNumber} issued — task created to submit to customer.`
  );
}
