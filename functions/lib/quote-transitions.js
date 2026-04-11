// functions/lib/quote-transitions.js
//
// Shared helpers for quote status transition routes. Each sibling
// transition route (submit.js, revise.js, accept.js, ...) is a thin
// wrapper around transitionQuote() below.
//
// Lives under lib/ (not in the quotes directory) because Cloudflare
// Pages Functions will route any .js file underneath functions/ —
// we don't want a /_transitions endpoint exposed by accident.

import { one, stmt, batch } from './db.js';
import { auditStmt } from './audit.js';
import { now } from './ids.js';
import { redirectWithFlash } from './http.js';

/**
 * Apply a simple status transition to a quote, with optional guard on
 * the current status and a set of field updates to include in the same
 * batch. Writes an audit_events row with `eventType` and `summary`.
 *
 * `opts`:
 *   from:             string[] — allowed current statuses (empty/undefined = any)
 *   to:               string   — target status
 *   eventType:        string   — audit_events.event_type value
 *   summaryFn:        (quote) => string
 *   extraSets:        { col: value | (quote, ts, user) => value }
 *   extraAuditChanges:(quote) => object — extra fields to merge into changes_json
 *   flashMessage:     (quote) => string — optional; defaults to a generic one
 */
export async function transitionQuote(context, opts) {
  const { env, data, params } = context;
  const user = data?.user;
  const oppId = params.id;
  const quoteId = params.quoteId;

  const {
    from,
    to,
    eventType,
    summaryFn,
    extraSets = {},
    extraAuditChanges,
    flashMessage,
  } = opts;

  const quote = await one(
    env.DB,
    'SELECT * FROM quotes WHERE id = ?',
    [quoteId]
  );
  if (!quote || quote.opportunity_id !== oppId) {
    return new Response('Quote not found', { status: 404 });
  }

  if (from && from.length && !from.includes(quote.status)) {
    return redirectWithFlash(
      `/opportunities/${oppId}/quotes/${quoteId}`,
      `Cannot transition from ${quote.status} to ${to}.`,
      'error'
    );
  }

  const ts = now();

  const setCols = ['status = ?', 'updated_at = ?'];
  const setParams = [to, ts];
  for (const [col, val] of Object.entries(extraSets)) {
    setCols.push(`${col} = ?`);
    setParams.push(typeof val === 'function' ? val(quote, ts, user) : val);
  }
  setParams.push(quoteId);

  const changes = {
    status: { from: quote.status, to },
    ...(extraAuditChanges ? extraAuditChanges(quote) : {}),
  };

  await batch(env.DB, [
    stmt(
      env.DB,
      `UPDATE quotes SET ${setCols.join(', ')} WHERE id = ?`,
      setParams
    ),
    auditStmt(env.DB, {
      entityType: 'quote',
      entityId: quoteId,
      eventType,
      user,
      summary: summaryFn(quote),
      changes,
    }),
  ]);

  const flash = flashMessage
    ? flashMessage(quote)
    : `Marked ${quote.number} Rev ${quote.revision} as ${to}.`;

  return redirectWithFlash(
    `/opportunities/${oppId}/quotes/${quoteId}`,
    flash
  );
}

/**
 * Snapshot currently-active governing document revisions. Returns an
 * object with tc_revision / warranty_revision / rate_schedule_revision /
 * sop_revision keys — any or all may be null if no active row exists
 * for that doc_key. Called when a quote is submitted so we freeze the
 * revisions in force at the moment of submission.
 */
export async function snapshotGoverningDocs(db) {
  const res = await db.prepare(
    `SELECT doc_key, revision
       FROM governing_documents
      WHERE status = 'active'`
  ).all();
  const map = new Map();
  for (const r of (res.results ?? [])) {
    map.set(r.doc_key, r.revision);
  }
  return {
    tc_revision:            map.get('terms')         ?? null,
    warranty_revision:      map.get('warranty')      ?? null,
    rate_schedule_revision: map.get('rate_schedule') ?? null,
    sop_revision:           map.get('refurb_sop')    ?? null,
  };
}
