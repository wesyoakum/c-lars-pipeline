// functions/ai-inbox/[id]/attachments/reorder.js
//
// POST /ai-inbox/:id/attachments/reorder
//
// Body: JSON { ids: [<att_id>, <att_id>, ...] }
//
// Sets sort_order on each attachment to its position in the array.
// Validates that every supplied id belongs to the entry and the user
// owns the entry; if any id is unknown or foreign, the whole call
// rejects so the UI doesn't end up half-reordered.
//
// Re-extraction is NOT triggered automatically; the user runs it
// manually when they want the new order to take effect in the LLM
// input (compileContext() respects sort_order).

import { one, all, stmt, batch } from '../../../lib/db.js';
import { now } from '../../../lib/ids.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;

  // Verify ownership of the entry first (cheaper than per-id checks).
  const entry = await one(env.DB,
    'SELECT id FROM ai_inbox_items WHERE id = ? AND user_id = ?',
    [params.id, user.id]);
  if (!entry) return json({ ok: false, error: 'not_found' }, 404);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const ids = Array.isArray(body?.ids) ? body.ids.filter((s) => typeof s === 'string') : null;
  if (!ids || ids.length === 0) {
    return json({ ok: false, error: 'ids_required' }, 400);
  }

  // Pull all current attachments for the entry. Validate that the
  // submitted ids are exactly that set (same length, same membership)
  // — partial reorders would leave gaps in sort_order which we'd
  // rather not paper over.
  const existing = await all(env.DB,
    'SELECT id FROM ai_inbox_attachments WHERE entry_id = ?',
    [params.id]);
  const existingSet = new Set(existing.map((r) => r.id));
  if (ids.length !== existingSet.size || !ids.every((id) => existingSet.has(id))) {
    return json({ ok: false, error: 'ids_must_match_existing_set' }, 400);
  }

  const ts = now();
  const stmts = ids.map((id, i) => stmt(env.DB,
    'UPDATE ai_inbox_attachments SET sort_order = ?, updated_at = ? WHERE id = ?',
    [i, ts, id]));
  await batch(env.DB, stmts);

  return json({ ok: true });
}
