// functions/jobs/[id]/issue-ntp.js
//
// POST /jobs/:id/issue-ntp — EPS only.
// Issues Notice to Proceed. Status: awaiting_ntp → handed_off.

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

  return redirectWithFlash(`/jobs/${jobId}`, `NTP${ntpNumber ? ` ${ntpNumber}` : ''} issued — job handed off.`);
}
