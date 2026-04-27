// functions/ai-inbox/[id]/entities/unmatch.js
//
// POST /ai-inbox/:id/entities/unmatch
//
// Deletes ALL match rows (overridden or not) for a given mention so the
// resolver can repopulate suggestions on the next /entities/resolve.
//
// Body (JSON):
//   { mention_kind, mention_idx }

import { one, run } from '../../../lib/db.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;

  const item = await one(
    env.DB,
    'SELECT id FROM ai_inbox_items WHERE id = ? AND user_id = ?',
    [params.id, user.id]
  );
  if (!item) return json({ ok: false, error: 'not_found' }, 404);

  let payload;
  try { payload = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const mentionKind = String(payload.mention_kind || '');
  const mentionIdx = Number.isInteger(payload.mention_idx) ? payload.mention_idx : 0;

  if (mentionKind !== 'person' && mentionKind !== 'organization') {
    return json({ ok: false, error: 'bad_mention_kind' }, 400);
  }

  await run(env.DB,
    `DELETE FROM ai_inbox_entity_matches
      WHERE item_id = ? AND mention_kind = ? AND mention_idx = ?`,
    [params.id, mentionKind, mentionIdx]);

  return json({ ok: true });
}
