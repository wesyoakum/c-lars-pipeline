// functions/ai-inbox/[id]/entities/resolve.js
//
// POST /ai-inbox/:id/entities/resolve
//
// Re-runs the entity resolver against this item's extracted_json.
// Replaces non-overridden match rows with fresh resolver output;
// user_overridden=1 rows are preserved.
//
// Response:
//   { ok: true, matches: [...] }   — all match rows for the item

import { one, all, stmt, batch } from '../../../lib/db.js';
import { uuid, now } from '../../../lib/ids.js';
import { resolveEntities } from '../../../lib/entity-resolver.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;

  const item = await one(
    env.DB,
    'SELECT id, extracted_json FROM ai_inbox_items WHERE id = ? AND user_id = ?',
    [params.id, user.id]
  );
  if (!item) return json({ ok: false, error: 'not_found' }, 404);

  let extracted = null;
  if (item.extracted_json) {
    try { extracted = JSON.parse(item.extracted_json); } catch { extracted = null; }
  }
  const people = (extracted?.people || []).filter(Boolean);
  const organizations = (extracted?.organizations || []).filter(Boolean);

  let candidates = [];
  try {
    candidates = await resolveEntities(env.DB, { people, organizations });
  } catch (e) {
    return json({ ok: false, error: 'resolver_failed', detail: String(e.message || e) }, 500);
  }

  const ts = now();
  const stmts = [
    stmt(env.DB,
      'DELETE FROM ai_inbox_entity_matches WHERE item_id = ? AND user_overridden = 0',
      [params.id]),
  ];
  for (const c of candidates) {
    stmts.push(stmt(env.DB,
      `INSERT INTO ai_inbox_entity_matches
         (id, item_id, mention_kind, mention_text, mention_idx,
          ref_type, ref_id, ref_label, score, rank,
          auto_resolved, user_overridden, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [uuid(), params.id, c.mention_kind, c.mention_text, c.mention_idx,
       c.ref_type, c.ref_id, c.ref_label, c.score, c.rank,
       c.auto_resolved, ts, ts]));
  }
  if (stmts.length > 0) await batch(env.DB, stmts);

  const matches = await all(env.DB,
    `SELECT id, mention_kind, mention_text, mention_idx, ref_type, ref_id,
            ref_label, score, rank, auto_resolved, user_overridden
       FROM ai_inbox_entity_matches WHERE item_id = ?
      ORDER BY mention_kind, mention_idx, rank`,
    [params.id]);

  return json({ ok: true, matches });
}
