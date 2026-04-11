// POST /opportunities/:id/quotes/:quoteId/submit
//
// Submit to customer: approved_internal → submitted. This is the one
// transition that snapshots the governance document revisions (T&Cs,
// warranty, rate schedule, refurb SOP) currently in force, so the quote
// record permanently reflects which version of each governing document
// applied at the moment of submission. Stamps submitted_at + submitted_by.

import { transitionQuote, snapshotGoverningDocs } from '../../../../lib/quote-transitions.js';

export async function onRequestPost(context) {
  const { env } = context;
  const snapshot = await snapshotGoverningDocs(env.DB);

  return transitionQuote(context, {
    from: ['draft', 'internal_review', 'approved_internal'],
    to: 'submitted',
    eventType: 'submitted',
    summaryFn: (q) =>
      `Submitted ${q.number} Rev ${q.revision} to customer ` +
      `(T&C ${snapshot.tc_revision ?? '—'}, Warranty ${snapshot.warranty_revision ?? '—'})`,
    extraSets: {
      submitted_at: (q, ts) => ts,
      submitted_by_user_id: (q, ts, user) => user?.id ?? null,
      tc_revision: snapshot.tc_revision,
      warranty_revision: snapshot.warranty_revision,
      rate_schedule_revision: snapshot.rate_schedule_revision,
      sop_revision: snapshot.sop_revision,
    },
    extraAuditChanges: () => ({
      governance_snapshot: snapshot,
    }),
  });
}
