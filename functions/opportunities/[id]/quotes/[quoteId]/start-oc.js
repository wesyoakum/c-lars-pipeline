// functions/opportunities/[id]/quotes/[quoteId]/start-oc.js
//
// POST /opportunities/:id/quotes/:quoteId/start-oc
//
// The accepted-quote detail page exposes a "Start Order Confirmation"
// button that POSTs here. Accepting the quote already auto-creates the
// job and moves the opp to `oc_drafted` (see accept.js), so this route
// is now mainly a navigation shortcut: find the job sourced from this
// quote (create it if for some reason it doesn't exist yet — e.g. quotes
// accepted before this behavior shipped) and drop the user on the
// /jobs/:jobId/oc form to capture the OC number and issue it.
//
// /jobs/:jobId/oc submits to /jobs/:jobId/issue-oc which fires the
// oc.issued auto-task event and advances the opp to `oc_submitted`.

import { one } from '../../../../lib/db.js';
import { ensureOcJobForQuote } from '../../../../lib/oc-jobs.js';
import { redirectWithFlash } from '../../../../lib/http.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const oppId = params.id;
  const quoteId = params.quoteId;

  const quote = await one(
    env.DB,
    'SELECT id, opportunity_id, status FROM quotes WHERE id = ?',
    [quoteId]
  );
  if (!quote || quote.opportunity_id !== oppId) {
    return new Response('Quote not found', { status: 404 });
  }

  if (quote.status !== 'accepted') {
    return redirectWithFlash(
      `/opportunities/${oppId}/quotes/${quoteId}`,
      `Only accepted quotes can start an OC (this one is ${quote.status}).`,
      'error'
    );
  }

  const job = await ensureOcJobForQuote(env, quoteId, { user });
  if (!job) {
    return new Response('Opportunity not found', { status: 404 });
  }

  return redirectWithFlash(
    `/jobs/${job.jobId}/oc`,
    job.created
      ? `Job ${job.number} created. Review the OC and issue.`
      : `Using existing job ${job.number}. Review the OC and issue.`
  );
}
