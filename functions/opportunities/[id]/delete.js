// POST /opportunities/:id/delete
//
// Hard-delete an opportunity and its cascading children (quotes,
// cost_builds, activities, documents, external_artifacts). Refuses
// when any job still references the opp — jobs represent execution
// handoff to Engineering/Ops, and we keep that history immutable.
// The user has to cancel or explicitly close out jobs first.
//
// Writes a final audit_events row BEFORE the DELETE so the tombstone
// survives in the log after the opp row is gone. (audit_events has
// no FK from entity_id, so this works.)

import { one, all, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
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

  const opp = await one(
    env.DB,
    'SELECT id, number, title FROM opportunities WHERE id = ?',
    [oppId]
  );
  if (!opp) {
    if (ajax) return jsonResponse({ ok: false, error: 'Opportunity not found.' }, 404);
    return new Response('Not found', { status: 404 });
  }

  // Job gate — jobs don't cascade on opportunity delete, so we'd hit
  // an FK error anyway. Report it nicely instead of letting D1 error
  // out mid-batch.
  const jobs = await all(
    env.DB,
    'SELECT id, number, status FROM jobs WHERE opportunity_id = ?',
    [oppId]
  );
  if (jobs.length > 0) {
    const summary = jobs.map(j => `${j.number} (${j.status})`).join(', ');
    const msg = `Cannot delete ${opp.number}: ${jobs.length} job${jobs.length === 1 ? '' : 's'} still attached — ${summary}. Cancel or delete the job(s) first.`;
    if (ajax) return jsonResponse({ ok: false, error: msg, blockers: jobs }, 409);
    return redirectWithFlash(`/opportunities/${oppId}`, msg, 'error');
  }

  // Pre-write the deletion audit event so it survives past the opp
  // row. auditStmt inserts into audit_events which is append-only.
  await batch(env.DB, [
    auditStmt(env.DB, {
      entityType: 'opportunity',
      entityId: oppId,
      eventType: 'deleted',
      user,
      summary: `Deleted opportunity ${opp.number} (${opp.title || 'no title'})`,
    }),
    // Cascade does the rest: quotes + quote_lines, cost_builds +
    // cost_lines, activities, documents, external_artifacts,
    // opp_contacts. Supporting tables with their own ON DELETE
    // CASCADE chains trickle further from there.
    stmt(env.DB, 'DELETE FROM opportunities WHERE id = ?', [oppId]),
  ]);

  if (ajax) return jsonResponse({ ok: true, id: oppId });
  return redirectWithFlash(
    '/opportunities',
    `Deleted ${opp.number} (${opp.title || 'no title'}).`
  );
}
