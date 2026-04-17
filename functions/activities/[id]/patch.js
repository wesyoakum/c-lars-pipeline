// functions/activities/[id]/patch.js
//
// POST /activities/:id/patch — inline field save (JSON).
//
// Accepts { field, value } and updates a single field on the activity.
// Returns JSON { ok, field, value, error? }.

import { one, stmt, batch } from '../../lib/db.js';
import { auditStmt, diff } from '../../lib/audit.js';
import { now } from '../../lib/ids.js';
import { fireEvent } from '../../lib/auto-tasks.js';

// Fields that may be patched inline, with optional coercion.
const PATCHABLE = new Set([
  'type', 'subject', 'body', 'direction', 'status',
  'due_at', 'assigned_user_id', 'opportunity_id',
]);

function coerce(field, raw) {
  const v = typeof raw === 'string' ? raw.trim() : raw;
  if (v === '' || v === null || v === undefined) return null;
  return v;
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const actId = params.id;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const { field, value: rawValue } = body;
  if (!field || !PATCHABLE.has(field)) {
    return json({ ok: false, error: `Field "${field}" is not editable` }, 400);
  }

  const before = await one(env.DB, `SELECT * FROM activities WHERE id = ?`, [actId]);
  if (!before) return json({ ok: false, error: 'Not found' }, 404);

  const newValue = coerce(field, rawValue);
  const ts = now();

  // Build diff for audit
  const changes = {};
  if (before[field] !== newValue) {
    changes[field] = { from: before[field], to: newValue };
  }

  // If status changed to completed, set completed_at
  let completedAt = before.completed_at;
  if (field === 'status') {
    if (newValue === 'completed' && before.status !== 'completed') {
      completedAt = ts;
    } else if (newValue !== 'completed') {
      completedAt = null;
    }
  }

  try {
    const setClauses = [`${field} = ?`, 'updated_at = ?'];
    const params = [newValue, ts];

    // Also update completed_at if status was changed
    if (field === 'status') {
      setClauses.push('completed_at = ?');
      params.push(completedAt);
    }

    params.push(actId);

    await batch(env.DB, [
      stmt(env.DB, `UPDATE activities SET ${setClauses.join(', ')} WHERE id = ?`, params),
      auditStmt(env.DB, {
        entityType: 'activity',
        entityId: actId,
        eventType: 'updated',
        user,
        summary: `Updated ${field}`,
        changes,
      }),
    ]);
  } catch (e) {
    return json({ ok: false, error: String(e.message ?? e) }, 500);
  }

  // Auto-tasks Phase 1 — fire task.completed when a task transitions
  // into the completed state. Only fires on the edge (pending → completed),
  // not on every patch of an already-completed row.
  if (
    field === 'status' &&
    newValue === 'completed' &&
    before.status !== 'completed' &&
    before.type === 'task'
  ) {
    try {
      const freshTask = { ...before, status: 'completed', completed_at: completedAt };
      const opp = before.opportunity_id
        ? await one(env.DB, 'SELECT * FROM opportunities WHERE id = ?', [before.opportunity_id])
        : null;
      const account = opp?.account_id
        ? await one(env.DB, 'SELECT * FROM accounts WHERE id = ?', [opp.account_id])
        : null;
      // Fire without awaiting — auto-task side effects must never block
      // the inline-edit response. Failures are logged in the engine.
      fireEvent(env, 'task.completed', {
        trigger: { user, at: ts },
        task: freshTask,
        opportunity: opp,
        account,
      }, user).catch((err) =>
        console.error('fireEvent(task.completed) failed:', err?.message || err)
      );
    } catch (err) {
      console.error('task.completed payload build failed:', err?.message || err);
    }
  }

  return json({ ok: true, field, value: newValue });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
