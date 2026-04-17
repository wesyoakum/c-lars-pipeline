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
import { fireEvent } from '../../lib/auto-tasks.js';

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const jobId = params.id;

  const job = await one(env.DB, 'SELECT * FROM jobs WHERE id = ?', [jobId]);
  if (!job) return redirectWithFlash('/jobs', 'Job not found.', 'error');

  if (job.status !== 'created') {
    return redirectWithFlash(`/jobs/${jobId}`, 'OC can only be issued when job is in Created status.', 'error');
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

  // Check whether the parent opp needs a stage advance. OC issued implies
  // the opp is in the oc_issued stage — nudge it there if it hasn't been
  // moved manually first. Skip for already-closed opps (respect closure).
  const opp = job.opportunity_id
    ? await one(env.DB, 'SELECT * FROM opportunities WHERE id = ?', [job.opportunity_id])
    : null;
  const CLOSED = new Set(['closed_won', 'closed_lost', 'closed_died', 'closed_abandoned']);
  const shouldAdvanceStage =
    opp && opp.stage !== 'oc_issued' && !CLOSED.has(opp.stage);
  const fromStage = opp?.stage ?? null;

  const stmts = [
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
  ];

  if (shouldAdvanceStage) {
    stmts.push(
      stmt(env.DB,
        `UPDATE opportunities SET stage = 'oc_issued', updated_at = ? WHERE id = ?`,
        [ts, opp.id]),
      auditStmt(env.DB, {
        entityType: 'opportunity',
        entityId: opp.id,
        eventType: 'stage_changed',
        user,
        summary: `Opportunity ${opp.number} stage advanced to oc_issued (OC ${ocNumber} issued)`,
        changes: { stage: { from: fromStage, to: 'oc_issued' } },
      })
    );
  }

  await batch(env.DB, stmts);

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

        if (shouldAdvanceStage && freshOpp) {
          await fireEvent(env, 'opportunity.stage_changed', {
            trigger: { user, at: ts },
            opportunity: freshOpp,
            account,
            stage_from: fromStage,
            stage_to: 'oc_issued',
          }, user);
        }
      } catch (err) {
        console.error('fireEvent(oc.issued) failed:', err?.message || err);
      }
    })()
  );

  const msg = newStatus === 'handed_off'
    ? `OC ${ocNumber} issued — job handed off.`
    : `OC ${ocNumber} issued — awaiting customer authorization.`;

  return redirectWithFlash(`/jobs/${jobId}`, msg);
}
