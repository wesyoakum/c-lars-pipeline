// functions/board/cards/[id]/index.js
//
// PATCH  /board/cards/:id  — edit body/color/flag/scope
// DELETE /board/cards/:id  — archive (soft delete)
//
// Authorization:
//   * Private cards: only the author.
//   * Direct cards:  the author, the direct-message recipient (target
//                    user), and admins. When the recipient edits the
//                    card, last_edited_by_user_id is stamped so the
//                    client can render their edits in blue (migration
//                    0044).
//   * Public cards:  author or admin.
//
// PATCH payload (all fields optional):
//   { body, color, flag, scope, target_user_id, pinned }

import { one, run } from '../../../lib/db.js';
import { now } from '../../../lib/ids.js';
import {
  parseRefs,
  rewriteCardRefs,
  normalizeColor,
  normalizeFlag,
  validateScope,
} from '../../../lib/board.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function canEdit(card, user) {
  if (!card || !user) return false;
  if (user.role === 'admin') return true;
  if (card.author_user_id === user.id) return true;
  // Direct-message cards can be edited by the recipient.
  if (card.scope === 'direct' && card.target_user_id === user.id) return true;
  return false;
}

export async function onRequestPatch(context) {
  const { env, request, params, data } = context;
  const user = data?.user;
  if (!user || !user.id) return json({ ok: false, error: 'unauthenticated' }, 401);

  const id = params.id;
  const card = await one(env.DB, 'SELECT * FROM board_cards WHERE id = ?', [id]);
  if (!card) return json({ ok: false, error: 'Not found.' }, 404);
  if (!canEdit(card, user)) return json({ ok: false, error: 'Not allowed.' }, 403);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON.' }, 400);
  }

  const updates = [];
  const values = [];
  let bodyChanged = false;
  let newBody = card.body;

  if (typeof payload.body === 'string') {
    const b = payload.body;
    if (!b.trim()) return json({ ok: false, error: 'Body cannot be empty.' }, 400);
    updates.push('body = ?');
    values.push(b);
    newBody = b;
    bodyChanged = b !== card.body;
  }
  if (typeof payload.color === 'string') {
    updates.push('color = ?');
    values.push(normalizeColor(payload.color));
  }
  if ('flag' in payload) {
    updates.push('flag = ?');
    values.push(normalizeFlag(payload.flag));
  }
  if (typeof payload.scope === 'string') {
    let newScope;
    try {
      newScope = validateScope(payload.scope);
    } catch (e) {
      return json({ ok: false, error: e.message }, 400);
    }
    updates.push('scope = ?');
    values.push(newScope);
    if (newScope === 'direct') {
      const targetId = (payload.target_user_id || '').toString();
      if (!targetId) return json({ ok: false, error: 'target_user_id required for direct scope.' }, 400);
      const target = await one(env.DB, 'SELECT id FROM users WHERE id = ? AND active = 1', [targetId]);
      if (!target) return json({ ok: false, error: 'Target user not found.' }, 400);
      updates.push('target_user_id = ?');
      values.push(targetId);
    } else {
      updates.push('target_user_id = NULL');
    }
  }
  if ('pinned' in payload) {
    updates.push('pinned = ?');
    values.push(payload.pinned ? 1 : 0);
  }
  if ('sort_order' in payload) {
    // Drag-to-reorder. Client computes the midpoint between the two
    // neighbors' sort_orders; we just persist it. REAL column so float
    // precision lasts for many drags before a renumber is ever needed.
    const n = Number(payload.sort_order);
    if (!Number.isFinite(n)) {
      return json({ ok: false, error: 'sort_order must be a finite number.' }, 400);
    }
    updates.push('sort_order = ?');
    values.push(n);
  }

  if (updates.length === 0) return json({ ok: false, error: 'Nothing to update.' }, 400);

  const ts = now();
  updates.push('updated_at = ?');
  values.push(ts);
  // Track who last edited so non-author edits can render in blue.
  // Sort_order changes alone don't count as an "edit" — those are
  // drag-to-reorder by anyone viewing the board. Body/color/flag
  // /scope /pinned changes do.
  const isContentEdit =
    bodyChanged ||
    payload.color !== undefined ||
    'flag' in payload ||
    typeof payload.scope === 'string' ||
    'pinned' in payload;
  if (isContentEdit) {
    updates.push('last_edited_by_user_id = ?');
    values.push(user.id);
  }
  values.push(id);

  await run(
    env.DB,
    `UPDATE board_cards SET ${updates.join(', ')} WHERE id = ?`,
    values
  );

  if (bodyChanged) {
    await rewriteCardRefs(env.DB, id, parseRefs(newBody));
  }

  const updated = await one(
    env.DB,
    `SELECT c.*, u.display_name AS author_display_name, u.email AS author_email
       FROM board_cards c LEFT JOIN users u ON u.id = c.author_user_id
      WHERE c.id = ?`,
    [id]
  );

  return json({ ok: true, card: updated });
}

export async function onRequestDelete(context) {
  const { env, params, data } = context;
  const user = data?.user;
  if (!user || !user.id) return json({ ok: false, error: 'unauthenticated' }, 401);

  const id = params.id;
  const card = await one(env.DB, 'SELECT * FROM board_cards WHERE id = ?', [id]);
  if (!card) return json({ ok: false, error: 'Not found.' }, 404);
  if (!canEdit(card, user)) return json({ ok: false, error: 'Not allowed.' }, 403);

  const ts = now();
  await run(
    env.DB,
    'UPDATE board_cards SET archived_at = ?, updated_at = ? WHERE id = ?',
    [ts, ts, id]
  );

  return json({ ok: true });
}
