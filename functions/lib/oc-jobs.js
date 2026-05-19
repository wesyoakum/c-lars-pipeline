// functions/lib/oc-jobs.js
//
// Find-or-create the job sourced from a specific accepted quote.
//
// An opportunity can have multiple accepted quotes, each producing its
// own job — the OC fields live on the job row, so a job from quote A
// must never be reused for quote B. The lookup is therefore keyed on
// jobs.quote_id, not opportunity_id.
//
// Two callers:
//   - functions/opportunities/[id]/quotes/[quoteId]/accept.js
//       auto-creates the job the moment the customer accepts.
//   - functions/opportunities/[id]/quotes/[quoteId]/start-oc.js
//       the manual "Start Order Confirmation" button — now just a
//       navigation shortcut that lands on the (already-created) job.
//
// Idempotent: if a non-cancelled job already exists for the quote it is
// returned untouched (`created:false`). Stage transitions, redirects and
// the accepted-status guard are the caller's responsibility.

import { one, stmt, batch } from './db.js';
import { auditStmt } from './audit.js';
import { uuid, now, nextNumber, currentYear } from './ids.js';

/**
 * @param {object} env   Pages env ({ DB })
 * @param {string} quoteId
 * @param {object} [opts]
 * @param {object} [opts.user]  acting user (for created_by + audit)
 * @returns {Promise<null | { jobId:string, number:string, created:boolean }>}
 *          null when the quote or its opportunity can't be found.
 */
export async function ensureOcJobForQuote(env, quoteId, { user } = {}) {
  const quote = await one(
    env.DB,
    'SELECT * FROM quotes WHERE id = ?',
    [quoteId]
  );
  if (!quote) return null;

  // Existing job sourced from THIS quote? Per-quote, not per-opp.
  const existing = await one(
    env.DB,
    `SELECT id, number FROM jobs
      WHERE quote_id = ? AND status != 'cancelled'`,
    [quoteId]
  );
  if (existing) {
    return { jobId: existing.id, number: existing.number, created: false };
  }

  const opp = await one(
    env.DB,
    `SELECT id, number, title, transaction_type, customer_po_number
       FROM opportunities
      WHERE id = ?`,
    [quote.opportunity_id]
  );
  if (!opp) return null;

  const id = uuid();
  const number = await nextNumber(env.DB, `JOB-${currentYear()}`);
  const ts = now();
  const isEps = String(opp.transaction_type || '')
    .split(',')
    .map((s) => s.trim())
    .includes('eps');

  await batch(env.DB, [
    stmt(
      env.DB,
      `INSERT INTO jobs
         (id, number, opportunity_id, quote_id, job_type, status, title,
          customer_po_number, ntp_required, created_at, updated_at,
          created_by_user_id)
       VALUES (?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?)`,
      [
        id, number, opp.id, quoteId, opp.transaction_type, opp.title,
        opp.customer_po_number || null, isEps ? 1 : 0, ts, ts,
        user?.id ?? null,
      ]
    ),
    auditStmt(env.DB, {
      entityType: 'job',
      entityId: id,
      eventType: 'created',
      user,
      summary: `Job ${number} created from accepted quote ${quote.number} Rev ${quote.revision}`,
      changes: {
        opportunity_id: opp.id,
        quote_id: quoteId,
        job_type: opp.transaction_type,
      },
    }),
  ]);

  return { jobId: id, number, created: true };
}
