// functions/ai-inbox/[id]/attachments/[att_id]/delete.js
//
// POST /ai-inbox/:id/attachments/:att_id/delete
//
// Hard-deletes an attachment row + its R2 file (if any). Best-effort
// on R2 — if the delete fails we still drop the DB row so the UI
// doesn't get stuck. Re-extraction is NOT triggered automatically;
// the user can hit "Re-run extraction" if they want it.
//
// Refuses to delete the last remaining attachment on an entry —
// extracting from no context is meaningless.

import { one, all, run } from '../../../../lib/db.js';
import { deleteFromR2 } from '../../../../lib/r2.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;

  // Look up attachment + verify ownership of its entry in one query.
  const att = await one(env.DB,
    `SELECT a.id, a.r2_key, a.is_primary
       FROM ai_inbox_attachments a
       JOIN ai_inbox_items i ON i.id = a.entry_id
      WHERE a.id = ? AND a.entry_id = ? AND i.user_id = ?`,
    [params.att_id, params.id, user.id]);
  if (!att) return json({ ok: false, error: 'not_found' }, 404);

  // Refuse to delete the last attachment.
  const siblings = await all(env.DB,
    'SELECT id, is_primary, sort_order FROM ai_inbox_attachments WHERE entry_id = ? AND id != ? ORDER BY sort_order, created_at',
    [params.id, params.att_id]);
  if (siblings.length === 0) {
    return json({ ok: false, error: 'cannot_delete_last_attachment' }, 400);
  }

  // Drop the DB row. If this was the primary, promote the first sibling
  // (whatever's at the top of sort_order) to primary so the entry
  // always has exactly one primary.
  await run(env.DB, 'DELETE FROM ai_inbox_attachments WHERE id = ?', [params.att_id]);
  if (att.is_primary === 1) {
    await run(env.DB,
      'UPDATE ai_inbox_attachments SET is_primary = 1 WHERE id = ?',
      [siblings[0].id]);
  }

  // Best-effort R2 cleanup.
  if (att.r2_key) {
    try {
      await deleteFromR2(env.DOCS, att.r2_key);
    } catch (e) {
      console.warn('[ai-inbox] r2 delete failed for', att.r2_key, e?.message || e);
    }
  }

  return json({ ok: true });
}
