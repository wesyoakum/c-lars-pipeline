// functions/opportunities/[id]/quotes/[quoteId]/start-oc.js
//
// POST /opportunities/:id/quotes/:quoteId/start-oc
//
// Entry point for "accept a quote → issue an Order Confirmation". The
// accepted-quote detail page exposes a single "Start Order Confirmation"
// button that POSTs here. This route:
//
//   1. Guards that the quote is actually accepted.
//   2. Looks up the active (non-cancelled) job on the parent opportunity.
//      - If one already exists, redirects to /jobs/:jobId so the user
//        can use the existing "Issue Order Confirmation" form there.
//      - If not, creates a new job (mirroring POST /jobs) and redirects
//        to the freshly-created /jobs/:jobId page.
//
// The OC number itself (and any customer PO) is entered on the job
// detail page via the existing issue-oc form — that route fires the
// oc.issued auto-task event which drives the seeded "Notify Finance to
// send initial invoice" rule (migration 0037).
//
// Why a separate route rather than reusing POST /jobs directly:
//   - POST /jobs expects form fields (`opportunity_id`, etc.). We want
//     a zero-field button on the quote page.
//   - The accepted-quote context lets us log a more specific audit
//     summary ("Job X created from accepted quote Y") than the generic
//     POST /jobs path.
//   - Keeps the button wiring trivial: <form action="…/start-oc">.

import { one, stmt, batch } from '../../../../lib/db.js';
import { auditStmt } from '../../../../lib/audit.js';
import { uuid, now, nextNumber, currentYear } from '../../../../lib/ids.js';
import { redirectWithFlash } from '../../../../lib/http.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const oppId = params.id;
  const quoteId = params.quoteId;

  const quote = await one(
    env.DB,
    'SELECT * FROM quotes WHERE id = ?',
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

  // Existing active job on this opp? If so, go straight there — the
  // user almost certainly just wants to hit the Issue OC form on the
  // job detail page.
  const existing = await one(
    env.DB,
    `SELECT id, number, status FROM jobs
      WHERE opportunity_id = ? AND status != 'cancelled'`,
    [oppId]
  );
  if (existing) {
    return redirectWithFlash(
      `/jobs/${existing.id}`,
      `Using existing job ${existing.number}. Enter the OC number below to issue it.`
    );
  }

  // No job yet — create one seeded from the opportunity, matching the
  // field set POST /jobs uses so the row is indistinguishable from a
  // manually-created job.
  const opp = await one(
    env.DB,
    `SELECT id, number, title, transaction_type, customer_po_number
       FROM opportunities
      WHERE id = ?`,
    [oppId]
  );
  if (!opp) {
    return new Response('Opportunity not found', { status: 404 });
  }

  const id = uuid();
  const number = await nextNumber(env.DB, `JOB-${currentYear()}`);
  const ts = now();

  const title = opp.title;
  const customerPo = opp.customer_po_number || null;
  const isEps = String(opp.transaction_type || '').split(',').map(s => s.trim()).includes('eps');

  await batch(env.DB, [
    stmt(
      env.DB,
      `INSERT INTO jobs
         (id, number, opportunity_id, job_type, status, title,
          customer_po_number, ntp_required, created_at, updated_at,
          created_by_user_id)
       VALUES (?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?)`,
      [
        id, number, oppId, opp.transaction_type, title,
        customerPo, isEps ? 1 : 0, ts, ts, user?.id ?? null,
      ]
    ),
    auditStmt(env.DB, {
      entityType: 'job',
      entityId: id,
      eventType: 'created',
      user,
      summary: `Job ${number} created from accepted quote ${quote.number} Rev ${quote.revision}`,
      changes: {
        opportunity_id: oppId,
        job_type: opp.transaction_type,
        source_quote_id: quoteId,
      },
    }),
  ]);

  return redirectWithFlash(
    `/jobs/${id}`,
    `Job ${number} created from ${quote.number} Rev ${quote.revision}. Enter the OC number below to issue it.`
  );
}
