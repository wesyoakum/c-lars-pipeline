// functions/jobs/[id]/delete.js
//
// POST /jobs/:id/delete — Soft-delete a job.
//
// Cascade children (all soft-deleted at the same timestamp):
//   change_orders (job_id), activities (job_id), documents (job_id),
//   cost_builds (job_id).
//
// Without ?cascade=1, refuses if any children exist (409 + summary).

import { one, all, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { softDeleteStmt, softDeleteChildrenStmt } from '../../lib/soft-delete.js';
import { now } from '../../lib/ids.js';
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
  const jobId = params.id;
  const json = wantsJson(request);
  const url = new URL(request.url);
  const cascade = url.searchParams.get('cascade') === '1';

  const job = await one(
    env.DB,
    `SELECT id, number, title FROM jobs WHERE id = ? AND deleted_at IS NULL`,
    [jobId]
  );
  if (!job) {
    const msg = 'Job not found';
    if (json) return jsonResponse({ ok: false, error: msg }, 404);
    return redirectWithFlash('/jobs', msg, 'error');
  }

  // Children that block the delete unless cascade=1
  const [changeOrders, activities, documents, costBuilds] = await Promise.all([
    all(env.DB,
      `SELECT id, number, title FROM change_orders WHERE job_id = ? AND deleted_at IS NULL`,
      [jobId]),
    all(env.DB,
      `SELECT id, type, subject FROM activities WHERE job_id = ? AND deleted_at IS NULL`,
      [jobId]),
    all(env.DB,
      `SELECT id, title FROM documents WHERE job_id = ? AND deleted_at IS NULL`,
      [jobId]),
    all(env.DB,
      `SELECT id, label FROM cost_builds WHERE job_id = ? AND deleted_at IS NULL`,
      [jobId]),
  ]);

  const totalChildren =
    changeOrders.length + activities.length + documents.length + costBuilds.length;

  if (totalChildren > 0 && !cascade) {
    const msg = `Cannot delete: this job has ${totalChildren} child record(s) (${changeOrders.length} change order(s), ${activities.length} task/note(s), ${documents.length} doc(s), ${costBuilds.length} cost build(s)). Confirm cascade-delete to remove them too.`;
    if (json) return jsonResponse({
      ok: false, error: msg,
      change_order_count: changeOrders.length,
      activity_count: activities.length,
      document_count: documents.length,
      cost_build_count: costBuilds.length,
    }, 409);
    return redirectWithFlash(`/jobs/${jobId}`, msg, 'error');
  }

  const ts = now();
  const statements = [];

  if (cascade) {
    // Audit each child type
    for (const co of changeOrders) {
      statements.push(auditStmt(env.DB, {
        entityType: 'change_order',
        entityId: co.id,
        eventType: 'deleted',
        user,
        summary: `Change order "${co.number || ''} \u00b7 ${co.title || ''}" removed (parent job cascade-deleted)`,
      }));
    }
    for (const a of activities) {
      const label = (a.subject || a.type || '(activity)').slice(0, 80);
      statements.push(auditStmt(env.DB, {
        entityType: 'activity',
        entityId: a.id,
        eventType: 'deleted',
        user,
        summary: `Activity "${label}" removed (parent job cascade-deleted)`,
      }));
    }
    for (const d of documents) {
      statements.push(auditStmt(env.DB, {
        entityType: 'document',
        entityId: d.id,
        eventType: 'deleted',
        user,
        summary: `Document "${d.title || '(untitled)'}" removed (parent job cascade-deleted)`,
      }));
    }
    for (const cb of costBuilds) {
      statements.push(auditStmt(env.DB, {
        entityType: 'cost_build',
        entityId: cb.id,
        eventType: 'deleted',
        user,
        summary: `Cost build "${cb.label || '(untitled)'}" removed (parent job cascade-deleted)`,
      }));
    }

    // Soft-delete children
    statements.push(softDeleteChildrenStmt(env.DB, 'change_orders', 'job_id', jobId, ts));
    statements.push(softDeleteChildrenStmt(env.DB, 'activities', 'job_id', jobId, ts));
    statements.push(softDeleteChildrenStmt(env.DB, 'documents', 'job_id', jobId, ts));
    statements.push(softDeleteChildrenStmt(env.DB, 'cost_builds', 'job_id', jobId, ts));
  }

  statements.push(
    auditStmt(env.DB, {
      entityType: 'job',
      entityId: jobId,
      eventType: 'deleted',
      user,
      summary: cascade && totalChildren > 0
        ? `Deleted job "${job.number || ''} \u00b7 ${job.title || ''}" (cascade: ${totalChildren} child record(s))`
        : `Deleted job "${job.number || ''} \u00b7 ${job.title || ''}"`,
    })
  );
  statements.push(softDeleteStmt(env.DB, 'jobs', jobId, ts));

  await batch(env.DB, statements);

  if (json) return jsonResponse({ ok: true, id: jobId });
  return redirectWithFlash('/jobs', `Deleted job "${job.number || ''} \u00b7 ${job.title || ''}".`, 'success', { undo: `/jobs/${jobId}/restore` });
}
