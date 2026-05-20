// functions/accounts/[id]/delete.js
//
// POST /accounts/:id/delete — Soft-delete an account.
//
// Cascade children (all soft-deleted at the same timestamp):
//   contacts (account_id), opportunities (account_id), and
//   transitively: quotes + quote_lines, activities, documents,
//   cost_builds, jobs + change_orders under those opps/jobs.
//
// Junction tables (cost_build_dm_selections, cost_build_labor_selections,
// cost_build_labor) don't have deleted_at — they stay in place so restore
// works cleanly.
//
// Without ?cascade=1, refuses if opportunities exist (409 + summary).

import { one, all, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { softDeleteStmt, softDeleteChildrenStmt } from '../../lib/soft-delete.js';
import { now } from '../../lib/ids.js';
import { layout, htmlResponse } from '../../lib/layout.js';
import { redirectWithFlash } from '../../lib/http.js';

function wantsJson(request) {
  const a = request.headers.get('accept') || '';
  return a.includes('application/json') && !a.includes('text/html');
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const accountId = params.id;
  const json = wantsJson(request);
  const url = new URL(request.url);
  const cascade = url.searchParams.get('cascade') === '1';

  const account = await one(
    env.DB,
    `SELECT id, name FROM accounts WHERE id = ? AND deleted_at IS NULL`,
    [accountId]
  );
  if (!account) {
    if (json) return jsonResponse({ ok: false, error: 'Account not found' }, 404);
    return htmlResponse(
      layout(
        'Not found',
        `<section class="card"><h1>Account not found</h1><p><a href="/accounts">Back</a></p></section>`,
        { user, env: data?.env, activeNav: '/accounts' }
      ),
      { status: 404 }
    );
  }

  const opps = await all(
    env.DB,
    `SELECT id, number, title FROM opportunities WHERE account_id = ? AND deleted_at IS NULL`,
    [accountId]
  );
  if (opps.length > 0 && !cascade) {
    const msg = `Cannot delete: ${opps.length} opportunit${opps.length === 1 ? 'y' : 'ies'} reference this account. Use cascade=1 to delete them too.`;
    if (json) return jsonResponse({ ok: false, error: msg, opportunity_count: opps.length }, 409);
    return redirectWithFlash(`/accounts/${accountId}`, msg, 'error');
  }

  const ts = now();
  const statements = [];

  // Cascade: soft-delete all jobs under this account's opps, then
  // the opps themselves, plus all their children.
  if (cascade && opps.length > 0) {
    const jobs = await all(env.DB,
      `SELECT j.id, j.number, j.title FROM jobs j
         JOIN opportunities o ON o.id = j.opportunity_id
        WHERE o.account_id = ? AND j.deleted_at IS NULL`,
      [accountId]);

    for (const j of jobs) {
      statements.push(auditStmt(env.DB, {
        entityType: 'job',
        entityId: j.id,
        eventType: 'deleted',
        user,
        summary: `Job "${j.number || ''} \u00b7 ${j.title || ''}" removed (parent account cascade-deleted)`,
      }));
      // Job children
      statements.push(softDeleteChildrenStmt(env.DB, 'change_orders', 'job_id', j.id, ts));
      statements.push(softDeleteChildrenStmt(env.DB, 'activities', 'job_id', j.id, ts));
      statements.push(softDeleteChildrenStmt(env.DB, 'documents', 'job_id', j.id, ts));
      statements.push(softDeleteChildrenStmt(env.DB, 'cost_builds', 'job_id', j.id, ts));
      statements.push(softDeleteStmt(env.DB, 'jobs', j.id, ts));
    }

    for (const o of opps) {
      statements.push(auditStmt(env.DB, {
        entityType: 'opportunity',
        entityId: o.id,
        eventType: 'deleted',
        user,
        summary: `Opportunity "${o.number || ''} \u00b7 ${o.title || ''}" removed (parent account cascade-deleted)`,
      }));
      // Quote_lines via their parent quotes (no opportunity_id FK on quote_lines)
      const quotes = await all(
        env.DB,
        'SELECT id FROM quotes WHERE opportunity_id = ? AND deleted_at IS NULL',
        [o.id]
      );
      for (const q of quotes) {
        statements.push(softDeleteChildrenStmt(env.DB, 'quote_lines', 'quote_id', q.id, ts));
      }
      // Opp children
      statements.push(softDeleteChildrenStmt(env.DB, 'quotes', 'opportunity_id', o.id, ts));
      statements.push(softDeleteChildrenStmt(env.DB, 'activities', 'opportunity_id', o.id, ts));
      statements.push(softDeleteChildrenStmt(env.DB, 'documents', 'opportunity_id', o.id, ts));
      statements.push(softDeleteChildrenStmt(env.DB, 'cost_builds', 'opportunity_id', o.id, ts));
      statements.push(softDeleteStmt(env.DB, 'opportunities', o.id, ts));
    }
  }

  // Contacts — always cascade (they belong to the account)
  const contacts = await all(
    env.DB,
    `SELECT id, first_name, last_name FROM contacts WHERE account_id = ? AND deleted_at IS NULL`,
    [accountId]
  );
  for (const c of contacts) {
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || '(no name)';
    statements.push(
      auditStmt(env.DB, {
        entityType: 'contact',
        entityId: c.id,
        eventType: 'deleted',
        user,
        summary: `Contact "${name}" removed (parent account deleted)`,
      })
    );
  }
  statements.push(softDeleteChildrenStmt(env.DB, 'contacts', 'account_id', accountId, ts));

  statements.push(
    auditStmt(env.DB, {
      entityType: 'account',
      entityId: accountId,
      eventType: 'deleted',
      user,
      summary: cascade && opps.length > 0
        ? `Deleted account "${account.name}" (cascade: ${opps.length} opp(s))`
        : `Deleted account "${account.name}"`,
    })
  );
  statements.push(softDeleteStmt(env.DB, 'accounts', accountId, ts));

  await batch(env.DB, statements);

  if (json) return jsonResponse({ ok: true, id: accountId });
  return redirectWithFlash(`/accounts`, `Deleted account "${account.name}".`, 'success', { undo: `/accounts/${accountId}/restore` });
}
