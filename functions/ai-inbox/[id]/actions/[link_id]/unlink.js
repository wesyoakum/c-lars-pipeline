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

import { one, run, stmt, batch } from '../../../../lib/db.js';
import { auditStmt } from '../../../../lib/audit.js';

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
    `SELECT l.id, l.action_type, l.ref_type, l.ref_id, l.ref_label
       FROM ai_inbox_links l
       JOIN ai_inbox_items i ON i.id = l.item_id
      WHERE l.id = ? AND l.item_id = ? AND i.user_id = ?`,
    [params.link_id, params.id, user.id]
  );
  if (!link) return json({ ok: false, error: 'not_found' }, 404);

  // Audit the underlying entity (when there is one — archive has none).
  const stmts = [
    stmt(env.DB, `DELETE FROM ai_inbox_links WHERE id = ?`, [link.id]),
  ];
  if (link.ref_type && link.ref_id) {
    stmts.push(auditStmt(env.DB, {
      entityType: link.ref_type,
      entityId: link.ref_id,
      eventType: 'updated',
      user,
      summary: 'Unlinked from AI Inbox',
    }));
  }
  await batch(env.DB, stmts);

  return json({ ok: true });
}
