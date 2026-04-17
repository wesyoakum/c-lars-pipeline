// functions/jobs/[id]/complete.js
//
// POST /jobs/:id/complete
//
// Transition a job from `handed_off` → `complete`. The new `complete`
// status is the terminal "job is actually done, not just handed off to
// the external PM system" state introduced in the active-only rules.
//
// Cascade: any `accepted` quote on the same opportunity flips to the
// hidden `completed` status in the same batch. The cascade only fires
// for `accepted` quotes — a separate `issued` quote on the same opp
// (e.g. a later-revision proposal that never landed) keeps its own
// lifecycle. This matches Wes's "a quote that resulted in a job" framing.
//
// Blocker: if the job or its parent opportunity has any pending task,
// we refuse the transition and surface the blockers. The caller (AJAX
// or form) decides how to render them:
//   - AJAX  → 409 + { ok:false, blockers: [...] }  (wizard modal)
//   - form  → redirect-with-flash summarizing the blockers
//
// We do not touch the opportunity's stage here. Marking the job
// `complete` is a job-level event; the opp can stay open (user might
// want to run a follow-up) or be closed separately.

import { one, stmt, batch, all } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { now } from '../../lib/ids.js';
import { redirectWithFlash, formBody } from '../../lib/http.js';
import { checkInactivateBlockers, summarizeBlockers } from '../../lib/inactivate-blocker.js';
import { fireEvent } from '../../lib/auto-tasks.js';

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

  if (job.status !== 'handed_off') {
    const msg = `Cannot mark complete — job is currently "${job.status}". Complete only applies from handed_off.`;
    if (ajax) return jsonResponse({ ok: false, error: msg }, 400);
    return redirectWithFlash(`/jobs/${jobId}`, msg, 'error');
  }

  // Blocker gate: pending tasks on the job or its parent opp.
  const blockers = await checkInactivateBlockers(env.DB, 'job', jobId);
  if (blockers.length > 0) {
    const summary = summarizeBlockers(blockers);
    if (ajax) {
      return jsonResponse({
        ok: false,
        error: `Cannot mark complete — ${summary}.`,
        blockers,
      }, 409);
    }
    return redirectWithFlash(`/jobs/${jobId}`, `Cannot mark complete — ${summary}.`, 'error');
  }

  const ts = now();

  // Find accepted quotes on the same opportunity — they cascade to
  // the hidden 'completed' status.
  const acceptedQuotes = await all(env.DB,
    `SELECT id, number, revision FROM quotes
      WHERE opportunity_id = ? AND status = 'accepted'`,
    [job.opportunity_id]);

  const statements = [
    stmt(env.DB,
      `UPDATE jobs SET status = 'complete', updated_at = ? WHERE id = ?`,
      [ts, jobId]),
    auditStmt(env.DB, {
      entityType: 'job',
      entityId: jobId,
      eventType: 'completed',
      user,
      summary: `Job ${job.number} marked complete`,
      changes: { status: { from: job.status, to: 'complete' } },
    }),
  ];

  acceptedQuotes.forEach((q) => {
    statements.push(
      stmt(env.DB,
        `UPDATE quotes SET status = 'completed', updated_at = ? WHERE id = ?`,
        [ts, q.id])
    );
    statements.push(
      auditStmt(env.DB, {
        entityType: 'quote',
        entityId: q.id,
        eventType: 'completed',
        user,
        summary: `Quote ${q.number} ${q.revision || ''} auto-completed because job ${job.number} completed`.trim(),
        changes: {
          status: { from: 'accepted', to: 'completed' },
          triggered_by_job: jobId,
        },
      })
    );
  });

  await batch(env.DB, statements);

  // Fire job.completed so auto-task rules (e.g. "close out opportunity")
  // can react. Non-blocking.
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
        await fireEvent(env, 'job.completed', {
          trigger: { user, at: ts },
          job: freshJob,
          opportunity,
          account,
          cascaded_quote_ids: acceptedQuotes.map((q) => q.id),
        }, user);
      } catch (err) {
        console.error('fireEvent(job.completed) failed:', err?.message || err);
      }
    })()
  );

  if (ajax) {
    return jsonResponse({
      ok: true,
      id: jobId,
      cascaded_quote_ids: acceptedQuotes.map((q) => q.id),
      redirectUrl: `/jobs/${jobId}`,
    });
  }

  const flash = acceptedQuotes.length
    ? `Job ${job.number} complete. ${acceptedQuotes.length} quote(s) marked completed.`
    : `Job ${job.number} complete.`;
  return redirectWithFlash(`/jobs/${jobId}`, flash);
}
