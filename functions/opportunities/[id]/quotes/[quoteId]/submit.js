// POST /opportunities/:id/quotes/:quoteId/submit
//
// Issue a quote to customer: draft → issued.
// Snapshots governance document revisions, stamps submitted_at/by,
// and auto-creates a task to submit the quote to the customer.

import { one, stmt, batch } from '../../../../lib/db.js';
import { auditStmt } from '../../../../lib/audit.js';
import { now } from '../../../../lib/ids.js';
import { redirectWithFlash } from '../../../../lib/http.js';
import { snapshotGoverningDocs, createIssueTask } from '../../../../lib/quote-transitions.js';
import { getQuoteDocData, fillTemplate, convertToPdf, templateKeyForQuote } from '../../../../lib/doc-generate.js';
import { storeGeneratedDoc } from '../../../../lib/doc-storage.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const oppId = params.id;
  const quoteId = params.quoteId;

  const quote = await one(env.DB, 'SELECT * FROM quotes WHERE id = ?', [quoteId]);
  if (!quote || quote.opportunity_id !== oppId) {
    return new Response('Quote not found', { status: 404 });
  }

  // Determine the target status based on current status
  const allowedFrom = ['draft', 'revision_draft'];
  if (!allowedFrom.includes(quote.status)) {
    return redirectWithFlash(
      `/opportunities/${oppId}/quotes/${quoteId}`,
      `Cannot issue from ${quote.status} status.`,
      'error'
    );
  }

  const targetStatus = quote.status === 'revision_draft' ? 'revision_issued' : 'issued';
  const snapshot = await snapshotGoverningDocs(env.DB);
  const ts = now();

  const statements = [
    stmt(env.DB,
      `UPDATE quotes
          SET status = ?, submitted_at = ?, submitted_by_user_id = ?,
              tc_revision = ?, warranty_revision = ?, rate_schedule_revision = ?, sop_revision = ?,
              updated_at = ?
        WHERE id = ?`,
      [targetStatus, ts, user?.id ?? null,
       snapshot.tc_revision, snapshot.warranty_revision,
       snapshot.rate_schedule_revision, snapshot.sop_revision,
       ts, quoteId]),
    auditStmt(env.DB, {
      entityType: 'quote',
      entityId: quoteId,
      eventType: 'issued',
      user,
      summary: `Issued ${quote.number} Rev ${quote.revision} to customer (${targetStatus})`,
      changes: {
        status: { from: quote.status, to: targetStatus },
        governance_snapshot: snapshot,
      },
    }),
  ];

  // Auto-create task to submit quote to customer
  const taskStmts = await createIssueTask(env.DB, quote, user);
  statements.push(...taskStmts);

  await batch(env.DB, statements);

  // Auto-generate PDF in the background (non-blocking)
  context.waitUntil(
    (async () => {
      try {
        const docData = await getQuoteDocData(env, quoteId);
        if (!docData) return;
        const templateKey = templateKeyForQuote(quote.quote_type);
        const docxBuffer = await fillTemplate(env, templateKey, docData);
        const baseFilename = quote.revision && quote.revision !== 'v1'
          ? `${quote.number}-${quote.revision}`
          : quote.number;

        const pdfBuffer = await convertToPdf(env, docxBuffer);
        await storeGeneratedDoc(env, {
          opportunityId: oppId, quoteId,
          buffer: pdfBuffer,
          filename: `${baseFilename}.pdf`,
          mimeType: 'application/pdf',
          kind: 'quote_pdf', user,
        });
      } catch (err) {
        console.error('Auto PDF generation failed:', err);
      }
    })()
  );

  return redirectWithFlash(
    `/opportunities/${oppId}/quotes/${quoteId}`,
    `Issued ${quote.number} Rev ${quote.revision}.`
  );
}
