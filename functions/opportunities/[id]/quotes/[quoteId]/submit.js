// POST /opportunities/:id/quotes/:quoteId/submit
//
// Issue a quote to customer: draft → issued.
// Snapshots governance document revisions and stamps submitted_at/by.
// The "submit quote to customer" task is now created by the seeded
// auto-task rule `rule-seed-submit-quote-to-customer` (migration 0037)
// via fireEvent('quote.issued') below — the old hard-coded
// createIssueTask helper was removed with that migration.

import { one, stmt, batch } from '../../../../lib/db.js';
import { auditStmt } from '../../../../lib/audit.js';
import { now } from '../../../../lib/ids.js';
import { redirectWithFlash } from '../../../../lib/http.js';
import { snapshotGoverningDocs } from '../../../../lib/quote-transitions.js';
import { getQuoteDocData, fillTemplate, convertToPdf, resolveQuoteTemplateKey } from '../../../../lib/doc-generate.js';
import { storeGeneratedDoc } from '../../../../lib/doc-storage.js';
import { templateTypeForQuote } from '../../../../lib/template-catalog.js';
import {
  getFilenameTemplate,
  renderFilenameTemplate,
  buildQuoteFilenameContext,
} from '../../../../lib/filename-templates.js';
import { fireEvent, reportError } from '../../../../lib/auto-tasks.js';
import { getEffectiveValidityDays } from '../../../../lib/quote-term-defaults.js';

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

  // Lock valid_until at issuance: submitted_at + N days (per quote_type
  // default from quote_term_defaults, migration 0038). If the user
  // explicitly set a date on the draft it wins — we only compute when
  // the column is still NULL.
  let lockedValidUntil = quote.valid_until;
  if (!lockedValidUntil) {
    const n = await getEffectiveValidityDays(env, quote.quote_type, 14);
    const base = new Date(ts);
    base.setUTCHours(0, 0, 0, 0);
    base.setUTCDate(base.getUTCDate() + n);
    lockedValidUntil = base.toISOString().slice(0, 10);
  }

  const statements = [
    stmt(env.DB,
      `UPDATE quotes
          SET status = ?, submitted_at = ?, submitted_by_user_id = ?,
              valid_until = ?,
              tc_revision = ?, warranty_revision = ?, rate_schedule_revision = ?, sop_revision = ?,
              updated_at = ?
        WHERE id = ?`,
      [targetStatus, ts, user?.id ?? null,
       lockedValidUntil,
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

  await batch(env.DB, statements);

  // Auto-tasks Phase 1 — fire quote.issued event into the rules engine.
  // waitUntil keeps rule evaluation off the critical path; failures
  // never roll back a successful quote issue.
  context.waitUntil(
    (async () => {
      try {
        const [freshQuote, opp, account] = await Promise.all([
          one(env.DB, 'SELECT * FROM quotes WHERE id = ?', [quoteId]),
          one(env.DB, 'SELECT * FROM opportunities WHERE id = ?', [oppId]),
          one(env.DB,
            `SELECT a.* FROM accounts a
               JOIN opportunities o ON o.account_id = a.id
              WHERE o.id = ?`,
            [oppId]),
        ]);
        await fireEvent(env, 'quote.issued', {
          trigger: { user, at: ts },
          quote: freshQuote,
          opportunity: opp,
          account,
        }, user);
      } catch (err) {
        console.error('fireEvent(quote.issued) failed:', err?.message || err);
      }
    })()
  );

  // Auto-generate PDF in the background (non-blocking)
  context.waitUntil(
    (async () => {
      try {
        const docData = await getQuoteDocData(env, quoteId);
        if (!docData) return;
        // Hybrid quotes try the shared quote-hybrid.docx first and
        // fall back to the primary type's template so auto-issue
        // keeps working before the hybrid template is uploaded.
        const { key: templateKey } =
          await resolveQuoteTemplateKey(env, quote.quote_type);
        const docxBuffer = await fillTemplate(env, templateKey, docData);

        // Build the download filename from the admin-configurable
        // template so the auto-issued PDF matches manually-generated
        // ones. Keyed by template catalog key (quote-spares, quote-
        // hybrid, …) with `.pdf` appended at the end.
        const fnCtx = buildQuoteFilenameContext({
          quote,
          accountName:       docData.clientName,
          accountAlias:      docData.clientAlias,
          opportunityNumber: docData.opportunityNumber,
          opportunityTitle:  docData.opportunityTitle,
        });
        const filenameKey = templateTypeForQuote(quote.quote_type);
        const fnTpl = await getFilenameTemplate(
          env,
          filenameKey,
          'C-LARS Quote {quoteNumber}{revisionSuffix}'
        );
        const pdfFilename =
          (renderFilenameTemplate(fnTpl, fnCtx) ||
            `${quote.number}${fnCtx.revisionSuffix}`) + '.pdf';

        const pdfBuffer = await convertToPdf(env, docxBuffer);
        await storeGeneratedDoc(env, {
          opportunityId: oppId, quoteId,
          buffer: pdfBuffer,
          filename: pdfFilename,
          mimeType: 'application/pdf',
          kind: 'quote_pdf', user,
        });
      } catch (err) {
        console.error('Auto PDF generation failed:', err);
        // Fire system.error so auto-task rules (e.g. "investigate PDF
        // failures") can react. Safe to call inside this catch — it
        // swallows its own errors.
        await reportError(env, 'pdf_generation_failed', {
          summary: `Auto PDF failed for ${quote.number} rev ${quote.revision}`,
          detail: err?.message || String(err),
          context: { oppId, quoteId, quote_type: quote.quote_type },
          user,
          quote,
        });
      }
    })()
  );

  return redirectWithFlash(
    `/opportunities/${oppId}/quotes/${quoteId}`,
    `Issued ${quote.number} Rev ${quote.revision}.`
  );
}
