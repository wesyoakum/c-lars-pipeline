// functions/lib/quote-transitions.js
//
// Shared helpers for quote status transition routes. Each sibling
// transition route (submit.js, revise.js, accept.js, ...) is a thin
// wrapper around transitionQuote() below.
//
// Lives under lib/ (not in the quotes directory) because Cloudflare
// Pages Functions will route any .js file underneath functions/ —
// we don't want a /_transitions endpoint exposed by accident.

import { one, all, stmt, batch } from './db.js';
import { auditStmt } from './audit.js';
import { uuid, now } from './ids.js';
import { redirectWithFlash } from './http.js';
import { INACTIVE_QUOTE_STATUSES } from './activeness.js';
import { checkInactivateBlockers, summarizeBlockers } from './inactivate-blocker.js';

function isAjaxRequest(request, input) {
  if (input && (input.source === 'wizard' || input.source === 'modal')) return true;
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
  const { env, data, params, request } = context;
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

  // Blocker gate: when the target status is one of the inactive ones
  // (rejected / dead / completed) we refuse if this quote has a pending
  // task or an active downstream job. Active targets (accepted, issued,
  // expired, ...) pass through unchanged.
  if (INACTIVE_QUOTE_STATUSES.indexOf(to) >= 0) {
    const blockers = await checkInactivateBlockers(env.DB, 'quote', quoteId);
    if (blockers.length > 0) {
      const ajax = request && isAjaxRequest(request, null);
      const summary = summarizeBlockers(blockers);
      const msg = `Cannot mark quote ${to} \u2014 ${summary}.`;
      if (ajax) return jsonResponse({ ok: false, error: msg, blockers }, 409);
      return redirectWithFlash(
        `/opportunities/${oppId}/quotes/${quoteId}`,
        msg,
        'error'
      );
    }
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
 * Create an auto-task when a quote is issued. Assigns to the opportunity
 * owner with a subject like "Submit Q25004-1 to [account name]".
 * Returns D1 prepared statements to include in a batch.
 */
export async function createIssueTask(db, quote, user) {
  const opp = await one(db,
    `SELECT o.id, o.owner_user_id, a.name AS account_name
       FROM opportunities o
       LEFT JOIN accounts a ON a.id = o.account_id
      WHERE o.id = ?`,
    [quote.opportunity_id]);
  if (!opp) return [];

  const taskId = uuid();
  const ts = now();
  const accountName = opp.account_name || 'customer';
  const subject = `Submit ${quote.number} to ${accountName}`;
  const assignedTo = opp.owner_user_id || user?.id || null;

  // Due date: next business day (skip weekends)
  const due = new Date();
  due.setDate(due.getDate() + 1);
  if (due.getDay() === 0) due.setDate(due.getDate() + 1); // Sunday → Monday
  if (due.getDay() === 6) due.setDate(due.getDate() + 2); // Saturday → Monday
  const dueAt = due.toISOString().slice(0, 10);

  return [
    stmt(db,
      `INSERT INTO activities
         (id, opportunity_id, type, subject, status, due_at, assigned_user_id, created_at, updated_at, created_by_user_id)
       VALUES (?, ?, 'task', ?, 'pending', ?, ?, ?, ?, ?)`,
      [taskId, opp.id, subject, dueAt, assignedTo, ts, ts, user?.id]),
    auditStmt(db, {
      entityType: 'activity',
      entityId: taskId,
      eventType: 'created',
      user,
      summary: `Auto-created task: ${subject}`,
    }),
  ];
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
