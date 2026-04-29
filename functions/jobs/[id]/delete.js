// functions/jobs/[id]/delete.js
//
// POST /jobs/:id/delete — delete a job.
//
// FK chain:
//   change_orders  → REFERENCES jobs(id)              (RESTRICT — explicit delete needed)
//   activities     → REFERENCES jobs(id) ON DELETE CASCADE
//   documents      → REFERENCES jobs(id) ON DELETE CASCADE
//   cost_builds    → REFERENCES jobs(id) ON DELETE CASCADE
//
// So we explicitly delete the job's change_orders first (RESTRICT),
// then the job itself; cascading handles activities / documents /
// cost_builds. Audits are written BEFORE the delete so the trail
// survives the cascade.
//
// Without `?cascade=1` the route refuses to delete a job with any
// children and returns a 409 + child-count summary so the shared
// `Pipeline.confirmCascadeDelete()` modal can list them. Same shape
// as accounts/[id]/delete.js and opportunities/[id]/delete.js.

import { one, all, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
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
    `SELECT id, number, title FROM jobs WHERE id = ?`,
    [jobId]
  );
  if (!job) {
    const msg = 'Job not found';
    if (json) return jsonResponse({ ok: false, error: msg }, 404);
    return redirectWithFlash('/jobs', msg, 'error');
  }

  // Children that block the delete unless cascade=1:
  //   change_orders (RESTRICT)
  //   activities    (CASCADE — but listed in preview so user knows)
  //   documents     (CASCADE — same)
  //   cost_builds   (CASCADE — same)
  const [changeOrders, activities, documents, costBuilds] = await Promise.all([
    all(env.DB,
      `SELECT id, number, title FROM change_orders WHERE job_id = ?`,
      [jobId]),
    all(env.DB,
      `SELECT id, type, subject FROM activities WHERE job_id = ?`,
      [jobId]),
    all(env.DB,
      `SELECT id, title FROM documents WHERE job_id = ?`,
      [jobId]),
    all(env.DB,
      `SELECT id, label FROM cost_builds WHERE job_id = ?`,
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

  // Pre-write audits so the tombstones survive the cascade.
  const statements = [];
  if (cascade) {
    for (const co of changeOrders) {
      statements.push(auditStmt(env.DB, {
        entityType: 'change_order',
        entityId: co.id,
        eventType: 'deleted',
        user,
        summary: `Change order "${co.number || ''} · ${co.title || ''}" removed (parent job cascade-deleted)`,
      }));
    }
    // activities / documents / cost_builds get CASCADE'd by FK; we
    // still write a per-row audit so the history page surfaces them.
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
    // Explicit delete of change_orders FIRST — FK is RESTRICT.
    for (const co of changeOrders) {
      statements.push(stmt(env.DB, `DELETE FROM change_orders WHERE id = ?`, [co.id]));
    }
  }

  statements.push(
    auditStmt(env.DB, {
      entityType: 'job',
      entityId: jobId,
      eventType: 'deleted',
      user,
      summary: cascade && totalChildren > 0
        ? `Deleted job "${job.number || ''} · ${job.title || ''}" (cascade: ${totalChildren} child record(s))`
        : `Deleted job "${job.number || ''} · ${job.title || ''}"`,
    })
  );
  statements.push(
    stmt(env.DB, `DELETE FROM jobs WHERE id = ?`, [jobId])
  );

  await batch(env.DB, statements);

  if (json) return jsonResponse({ ok: true, id: jobId });
  return redirectWithFlash('/jobs', `Deleted job "${job.number || ''} · ${job.title || ''}".`);
}
