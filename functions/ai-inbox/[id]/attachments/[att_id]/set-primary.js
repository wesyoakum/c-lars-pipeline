// functions/ai-inbox/[id]/attachments/[att_id]/set-primary.js
//
// POST /ai-inbox/:id/attachments/:att_id/set-primary
//
// Promotes one attachment to primary, demoting all others on the same
// entry. compileContext() pins the primary to the top of the LLM input
// regardless of sort_order, so this is a meaningful editorial choice
// when an entry has multiple attachments of different "weight" (e.g.
// a long meeting recording vs. a short follow-up note).
//
// Re-extraction is NOT triggered — the user can hit "Re-run extraction"
// if they want the change to flow through to the next extraction.

import { one, run, stmt, batch } from '../../../../lib/db.js';
import { now } from '../../../../lib/ids.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;

  // Verify ownership in one query.
  const att = await one(env.DB,
    `SELECT a.id
       FROM ai_inbox_attachments a
       JOIN ai_inbox_items i ON i.id = a.entry_id
      WHERE a.id = ? AND a.entry_id = ? AND i.user_id = ?`,
    [params.att_id, params.id, user.id]);
  if (!att) return json({ ok: false, error: 'not_found' }, 404);

  const ts = now();
  // Two-step: demote everyone, then promote the picked one. Wrap in a
  // batch so a half-applied state doesn't strand the entry without a
  // primary if D1 hiccups mid-flight.
  await batch(env.DB, [
    stmt(env.DB,
      'UPDATE ai_inbox_attachments SET is_primary = 0, updated_at = ? WHERE entry_id = ?',
      [ts, params.id]),
    stmt(env.DB,
      'UPDATE ai_inbox_attachments SET is_primary = 1, updated_at = ? WHERE id = ?',
      [ts, params.att_id]),
  ]);

  return json({ ok: true });
}
