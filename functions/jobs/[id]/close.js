// functions/jobs/[id]/close.js
//
// POST /jobs/:id/close — Close a job.

import { one, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { now } from '../../lib/ids.js';
import { redirectWithFlash, formBody } from '../../lib/http.js';
import { checkInactivateBlockers, summarizeBlockers } from '../../lib/inactivate-blocker.js';

function isAjaxRequest(request, input) {
  if (input?.source === 'wizard' || input?.source === 'modal') return true;
  const xrw = request.headers.get('x-requested-with');
  if (xrw && xrw.toLowerCase() === 'xmlhttprequest') return true;
  const accept = request.headers.get('accept') || '';
  return accept.includes('application/json') && !accept.includes('text/html');
}
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const jobId = params.id;
  const input = await formBody(request);
  const ajax = isAjaxRequest(request, input);

  const job = await one(env.DB, 'SELECT * FROM jobs WHERE id = ?', [jobId]);
  if (!job) {
    if (ajax) return jsonResponse({ ok: false, error: 'Job not found.' }, 404);
    return redirectWithFlash('/jobs', 'Job not found.', 'error');
  }

  if (job.status === 'handed_off' || job.status === 'cancelled' || job.status === 'complete') {
    const msg = 'Cannot close a job that is already handed off, complete, or cancelled.';
    if (ajax) return jsonResponse({ ok: false, error: msg }, 400);
    return redirectWithFlash(`/jobs/${jobId}`, msg, 'error');
  }

  // Blocker gate: pending tasks on this job or its parent opportunity.
  const blockers = await checkInactivateBlockers(env.DB, 'job', jobId);
  if (blockers.length > 0) {
    const summary = summarizeBlockers(blockers);
    const msg = `Cannot cancel this job \u2014 ${summary}.`;
    if (ajax) return jsonResponse({ ok: false, error: msg, blockers }, 409);
    return redirectWithFlash(`/jobs/${jobId}`, msg, 'error');
  }

  const ts = now();
  const reason = (input.reason || '').trim() || null;

  await batch(env.DB, [
    stmt(env.DB,
      `UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ?`,
      [ts, jobId]),
    auditStmt(env.DB, {
      entityType: 'job',
      entityId: jobId,
      eventType: 'closed',
      user,
      summary: `Job closed${reason ? `: ${reason}` : ''}`,
      changes: {
        status: { from: job.status, to: 'cancelled' },
      },
    }),
  ]);

  if (ajax) {
    return jsonResponse({ ok: true, id: jobId, redirectUrl: `/jobs/${jobId}` });
  }
  return redirectWithFlash(`/jobs/${jobId}`, 'Job closed.');
}
