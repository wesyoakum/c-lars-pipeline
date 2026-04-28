// functions/ai-inbox/[id]/actions/[link_id]/unlink.js
//
// POST /ai-inbox/:id/actions/:link_id/unlink
//
// Hard-deletes a single ai_inbox_links row. The underlying activity /
// account / contact is NEVER touched — unlinking is a relationship
// operation, not a delete. This matches the AI Inbox hard-delete
// convention (no soft-delete column on ai_inbox_links).
//
// Response:
//   { ok: true }
//   { ok: false, error }

import { one, run } from '../../../../lib/db.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;

  // Only the inbox item's owner can unlink. Verify ownership AND that
  // the link belongs to this item in a single query.
  const link = await one(
    env.DB,
    `SELECT l.id
       FROM ai_inbox_links l
       JOIN ai_inbox_items i ON i.id = l.item_id
      WHERE l.id = ? AND l.item_id = ? AND i.user_id = ?`,
    [params.link_id, params.id, user.id]
  );
  if (!link) return json({ ok: false, error: 'not_found' }, 404);

  // Drop the link row only. No audit_events write on the underlying
  // entity — see link-account.js for rationale.
  await run(env.DB, 'DELETE FROM ai_inbox_links WHERE id = ?', [link.id]);

  return json({ ok: true });
}
