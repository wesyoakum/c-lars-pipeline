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
import { getQuoteDocData, renderPdfOrPlaceholder, resolveQuoteTemplateKey } from '../../../../lib/doc-generate.js';
import { storeGeneratedDoc } from '../../../../lib/doc-storage.js';
import { templateTypeForQuote } from '../../../../lib/template-catalog.js';
import {
  getFilenameTemplate,
  renderFilenameTemplate,
  buildQuoteFilenameContext,
} from '../../../../lib/filename-templates.js';
import { fireEvent, reportError } from '../../../../lib/auto-tasks.js';
import { getEffectiveValidityDays } from '../../../../lib/quote-term-defaults.js';
import { notifyQuoteStatusChange } from '../../../../lib/notify-external.js';

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

  // Phase 7d-2 — fire external notification to the quote creator.
  // Skip-self enforced downstream by notify_self_actions setting.
  context.waitUntil(
    notifyQuoteStatusChange(env, {
      quote: { ...quote, status: targetStatus },
      previous_status: quote.status,
      new_status:      targetStatus,
      actorUserId:     user?.id || null,
      actor:           user?.display_name || user?.email || 'Someone',
      ts,
    }).catch(err => console.error('notifyQuoteStatusChange (submit) failed:', err?.message || err))
  );

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
        // Change-order quotes fire their own event so the CO submit-task
        // rule picks them up instead of the baseline one.
        const eventName = freshQuote?.change_order_id
          ? 'change_order.issued'
          : 'quote.issued';
        await fireEvent(env, eventName, {
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

  // Auto-generate the PDF synchronously so we can deliver it as an
  // immediate download on the redirect. When the .docx template is
  // missing from R2 we emit a placeholder PDF instead of failing, so
  // the download flow always delivers something.
  let downloadDocId = null;
  try {
    const docData = await getQuoteDocData(env, quoteId);
    if (docData) {
      const isCO = !!quote.change_order_id;
      const { key: templateKey } =
        await resolveQuoteTemplateKey(env, quote.quote_type, { isChangeOrder: isCO });

      const fnCtx = buildQuoteFilenameContext({
        quote,
        accountName:       docData.clientName,
        accountAlias:      docData.clientAlias,
        opportunityNumber: docData.opportunityNumber,
        opportunityTitle:  docData.opportunityTitle,
      });
      const filenameKey = templateTypeForQuote(quote.quote_type, { isChangeOrder: isCO });
      const fnTpl = await getFilenameTemplate(
        env,
        filenameKey,
        'C-LARS Quote {quoteNumber}{revisionSuffix}'
      );
      const pdfFilename =
        (renderFilenameTemplate(fnTpl, fnCtx) ||
          `${quote.number}${fnCtx.revisionSuffix}`) + '.pdf';

      const { buffer: pdfBuffer, isPlaceholder } =
        await renderPdfOrPlaceholder(env, templateKey, docData, filenameKey);
      downloadDocId = await storeGeneratedDoc(env, {
        opportunityId: oppId, quoteId,
        buffer: pdfBuffer,
        filename: isPlaceholder
          ? pdfFilename.replace(/\.pdf$/, ' (placeholder).pdf')
          : pdfFilename,
        mimeType: 'application/pdf',
        kind: 'quote_pdf', user,
      });
    }
  } catch (err) {
    console.error('Auto PDF generation failed:', err);
    context.waitUntil(
      reportError(env, 'pdf_generation_failed', {
        summary: `Auto PDF failed for ${quote.number} rev ${quote.revision}`,
        detail: err?.message || String(err),
        context: { oppId, quoteId, quote_type: quote.quote_type },
        user,
        quote,
      }).catch(() => {})
    );
  }

  const returnTo = `/opportunities/${oppId}/quotes/${quoteId}`;
  const redirectUrl = downloadDocId
    ? `${returnTo}?download=${encodeURIComponent(downloadDocId)}`
    : returnTo;
  return redirectWithFlash(
    redirectUrl,
    `Issued ${quote.number} Rev ${quote.revision}.`
  );
}
