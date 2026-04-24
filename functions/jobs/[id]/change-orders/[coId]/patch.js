// functions/jobs/[id]/change-orders/[coId]/patch.js
//
// POST /jobs/:id/change-orders/:coId/patch — inline-edit a single
// field on a change order. Currently only `description` is editable;
// status/amended_oc_* transitions happen through dedicated endpoints.

import { one, stmt, batch } from '../../../../lib/db.js';
import { auditStmt } from '../../../../lib/audit.js';
import { now } from '../../../../lib/ids.js';

const EDITABLE = new Set(['description']);

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const jobId = params.id;
  const coId = params.coId;

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: 'Bad JSON body' }, 400);
  }
  const field = payload?.field;
  if (!EDITABLE.has(field)) {
    return json({ ok: false, error: `Field ${field} is not editable.` }, 400);
  }
  const value = (payload?.value ?? '').toString().trim() || null;

  const co = await one(
    env.DB,
    'SELECT id, description FROM change_orders WHERE id = ? AND job_id = ?',
    [coId, jobId]
  );
  if (!co) return json({ ok: false, error: 'CO not found' }, 404);

  const ts = now();
  await batch(env.DB, [
    stmt(env.DB,
      `UPDATE change_orders SET ${field} = ?, updated_at = ? WHERE id = ?`,
      [value, ts, coId]),
    auditStmt(env.DB, {
      entityType: 'change_order',
      entityId: coId,
      eventType: 'updated',
      user,
      summary: `Updated ${field}`,
      changes: { [field]: { from: co[field], to: value } },
    }),
  ]);

  return json({ ok: true, value });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
