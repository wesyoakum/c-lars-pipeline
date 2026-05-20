// POST /opportunities/:id/delete
//
// Soft-delete an opportunity and its cascading children. Refuses when
// any job still references the opp without ?cascade=1 — jobs represent
// execution handoff to Engineering/Ops.
//
// Cascade children (all soft-deleted at the same timestamp):
//   quotes + their quote_lines, activities, documents, cost_builds,
//   and (with cascade=1) jobs + their change_orders/activities/docs/builds.
//
// Junction tables (cost_build_dm_selections, cost_build_labor_selections,
// cost_build_labor) don't have deleted_at — they stay in place so restore
// works cleanly.

import { one, all, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { softDeleteStmt, softDeleteChildrenStmt } from '../../lib/soft-delete.js';
import { now } from '../../lib/ids.js';
import { redirectWithFlash } from '../../lib/http.js';

function isAjaxRequest(request) {
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

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const oppId = params.id;
  const ajax = isAjaxRequest(request);
  const url = new URL(request.url);
  const cascade = url.searchParams.get('cascade') === '1';

  const opp = await one(
    env.DB,
    'SELECT id, number, title FROM opportunities WHERE id = ? AND deleted_at IS NULL',
    [oppId]
  );
  if (!opp) {
    if (ajax) return jsonResponse({ ok: false, error: 'Opportunity not found.' }, 404);
    return new Response('Not found', { status: 404 });
  }

  // Job gate
  const jobs = await all(
    env.DB,
    'SELECT id, number, title, status FROM jobs WHERE opportunity_id = ? AND deleted_at IS NULL',
    [oppId]
  );
  if (jobs.length > 0 && !cascade) {
    const summary = jobs.map(j => `${j.number} (${j.status})`).join(', ');
    const msg = `Cannot delete ${opp.number}: ${jobs.length} job${jobs.length === 1 ? '' : 's'} still attached \u2014 ${summary}. Use cascade=1 to delete them too.`;
    if (ajax) return jsonResponse({ ok: false, error: msg, blockers: jobs }, 409);
    return redirectWithFlash(`/opportunities/${oppId}`, msg, 'error');
  }

  const ts = now();
  const statements = [];

  // Cascade: soft-delete jobs and their children first
  if (cascade) {
    for (const j of jobs) {
      statements.push(auditStmt(env.DB, {
        entityType: 'job',
        entityId: j.id,
        eventType: 'deleted',
        user,
        summary: `Job ${j.number || ''} removed (parent opportunity cascade-deleted)`,
      }));
      // Job children
      statements.push(softDeleteChildrenStmt(env.DB, 'change_orders', 'job_id', j.id, ts));
      statements.push(softDeleteChildrenStmt(env.DB, 'activities', 'job_id', j.id, ts));
      statements.push(softDeleteChildrenStmt(env.DB, 'documents', 'job_id', j.id, ts));
      statements.push(softDeleteChildrenStmt(env.DB, 'cost_builds', 'job_id', j.id, ts));
      statements.push(softDeleteStmt(env.DB, 'jobs', j.id, ts));
    }
  }

  // Opportunity direct children
  statements.push(auditStmt(env.DB, {
    entityType: 'opportunity',
    entityId: oppId,
    eventType: 'deleted',
    user,
    summary: cascade && jobs.length > 0
      ? `Deleted opportunity ${opp.number} (cascade: ${jobs.length} job(s))`
      : `Deleted opportunity ${opp.number} (${opp.title || 'no title'})`,
  }));

  // Soft-delete quote_lines via their parent quotes (quote_lines has
  // quote_id, not opportunity_id).
  const quotes = await all(
    env.DB,
    'SELECT id FROM quotes WHERE opportunity_id = ? AND deleted_at IS NULL',
    [oppId]
  );
  for (const q of quotes) {
    statements.push(softDeleteChildrenStmt(env.DB, 'quote_lines', 'quote_id', q.id, ts));
  }

  // Soft-delete opp's own children
  statements.push(softDeleteChildrenStmt(env.DB, 'quotes', 'opportunity_id', oppId, ts));
  statements.push(softDeleteChildrenStmt(env.DB, 'activities', 'opportunity_id', oppId, ts));
  statements.push(softDeleteChildrenStmt(env.DB, 'documents', 'opportunity_id', oppId, ts));
  statements.push(softDeleteChildrenStmt(env.DB, 'cost_builds', 'opportunity_id', oppId, ts));
  statements.push(softDeleteStmt(env.DB, 'opportunities', oppId, ts));

  await batch(env.DB, statements);

  if (ajax) return jsonResponse({ ok: true, id: oppId });
  return redirectWithFlash(
    '/opportunities',
    `Deleted ${opp.number} (${opp.title || 'no title'}).`,
    'success',
    { undo: `/opportunities/${oppId}/restore` }
  );
}
