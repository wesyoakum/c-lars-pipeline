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
import { INACTIVE_QUOTE_STATUSES } from './activeness.js';
import { checkInactivateBlockers, summarizeBlockers } from './inactivate-blocker.js';
import { fireEvent } from './auto-tasks.js';
import { notifyQuoteStatusChange } from './notify-external.js';

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
 *   fireEventName:    string — optional; if set, fire this auto-tasks event
 *                     after the main batch commits (non-blocking via waitUntil).
 *                     Payload is assembled as {trigger, quote, opportunity,
 *                     account} using fresh row reads so seeded rules see the
 *                     post-transition state.
 *   afterCommit:      async (context, quote) => void — optional; awaited after
 *                     the status UPDATE commits. Used to chain in-request side
 *                     effects like opportunity-stage transitions. Errors are
 *                     logged but do not roll back the main status change.
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
    fireEventName,
    afterCommit,
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

  // Chained in-request side effects (e.g. opportunity stage transition).
  // Awaited so the caller's Response reflects the post-side-effect state,
  // but errors are logged and swallowed to match the fire-and-forget
  // semantics of fireEventName.
  if (afterCommit) {
    try {
      await afterCommit(context, quote);
    } catch (err) {
      console.error(
        `transitionQuote afterCommit (${eventType}) failed:`,
        err?.message || err
      );
    }
  }

  // Phase 7d-2: external notification to the quote's creator. Skip-self
  // is enforced inside notifyQuoteStatusChange → notifyExternal based on
  // the recipient's notify_self_actions toggle. Same fire-and-forget
  // pattern as auto-tasks below.
  if (context.waitUntil) {
    context.waitUntil(
      notifyQuoteStatusChange(env, {
        quote: { ...quote, status: to },  // give the helper the post-update view
        previous_status: quote.status,
        new_status:      to,
        actorUserId:     user?.id || null,
        actor:           user?.display_name || user?.email || 'Someone',
        ts,
      }).catch(err => console.error('notifyQuoteStatusChange failed:', err?.message || err))
    );
  }

  // Auto-tasks fan-out. Kept off the critical path via waitUntil so a
  // rule-engine glitch never rolls back a successful status transition.
  if (fireEventName && context.waitUntil) {
    context.waitUntil(
      (async () => {
        try {
          const [freshQuote, opp, account] = await Promise.all([
            one(env.DB, 'SELECT * FROM quotes WHERE id = ?', [quoteId]),
            one(env.DB, 'SELECT * FROM opportunities WHERE id = ?', [oppId]),
            one(
              env.DB,
              `SELECT a.* FROM accounts a
                 JOIN opportunities o ON o.account_id = a.id
                WHERE o.id = ?`,
              [oppId]
            ),
          ]);
          await fireEvent(
            env,
            fireEventName,
            {
              trigger: { user, at: ts },
              quote: freshQuote,
              opportunity: opp,
              account,
            },
            user
          );
        } catch (err) {
          console.error(
            `fireEvent(${fireEventName}) failed:`,
            err?.message || err
          );
        }
      })()
    );
  }

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
