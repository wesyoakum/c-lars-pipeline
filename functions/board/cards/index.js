// functions/board/cards/index.js
//
// POST /board/cards
//
// Create a new card. Accepts JSON:
//   {
//     scope:   'private' | 'public' | 'direct',   (required)
//     body:    string,                            (required, non-empty after trim)
//     color:   'yellow' | 'pink' | 'blue' | 'green' | 'orange' | 'white',
//     flag:    'red' | 'yellow' | 'green' | null,
//     target_user_id: uuid | null,                (optional for 'direct'; see below)
//     pinned:  bool                               (default false)
//   }
//
// For scope='direct' (chat messages):
//   - If target_user_id is supplied explicitly, use that.
//   - Else if the body contains exactly one @user mention, target that user.
//   - Else target_user_id stays NULL → broadcast (visible to everyone in
//     the team chat). State endpoint surfaces NULL-target direct cards
//     to all users.
//
// Returns: { ok: true, card: {...} }

import { run, one } from '../../lib/db.js';
import { uuid, now } from '../../lib/ids.js';
import {
  parseRefs,
  rewriteCardRefs,
  normalizeColor,
  normalizeFlag,
  validateScope,
} from '../../lib/board.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export async function onRequestPost(context) {
  const { env, request, data } = context;
  const user = data?.user;
  if (!user || !user.id) return json({ ok: false, error: 'unauthenticated' }, 401);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON.' }, 400);
  }

  const body = (payload.body || '').toString();
  if (!body.trim()) return json({ ok: false, error: 'Body is required.' }, 400);

  let scope;
  try {
    scope = validateScope(payload.scope);
  } catch (e) {
    return json({ ok: false, error: e.message }, 400);
  }

  // Parse refs once — also used to infer message target below.
  const refs = parseRefs(body);

  let targetUserId = null;
  if (scope === 'direct') {
    if (payload.target_user_id) {
      // Explicit target (legacy callers / future direct-DM UI).
      targetUserId = payload.target_user_id.toString();
    } else {
      // Auto-target from @user mentions: exactly one user mention
      // becomes a directed message; zero or many means broadcast.
      const userRefs = refs.filter((r) => r.ref_type === 'user');
      if (userRefs.length === 1) targetUserId = userRefs[0].ref_id;
    }
    if (targetUserId) {
      const target = await one(env.DB, 'SELECT id FROM users WHERE id = ? AND active = 1', [targetUserId]);
      if (!target) return json({ ok: false, error: 'Target user not found.' }, 400);
    }
    // else NULL → broadcast (visible to everyone in the chat).
  }

  const color = normalizeColor(payload.color);
  const flag = normalizeFlag(payload.flag);
  const pinned = payload.pinned ? 1 : 0;

  const id = uuid();
  const ts = now();

  // sort_order: epoch ms of insert time. Higher = closer to top so
  // the natural "newest first" default works without a separate
  // tiebreaker. Drag-to-reorder later overwrites this with a
  // computed midpoint between two neighbors' sort_orders.
  const sortOrder = Date.now();

  await run(
    env.DB,
    `INSERT INTO board_cards
       (id, author_user_id, scope, target_user_id, body, color, flag, pinned,
        snooze_until, archived_at, created_at, updated_at, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    [id, user.id, scope, targetUserId, body, color, flag, pinned, ts, ts, sortOrder]
  );

  if (refs.length > 0) await rewriteCardRefs(env.DB, id, refs);

  return json({
    ok: true,
    card: {
      id,
      author_user_id: user.id,
      author_display_name: user.display_name,
      author_email: user.email,
      scope,
      target_user_id: targetUserId,
      body,
      color,
      flag,
      pinned,
      snooze_until: null,
      created_at: ts,
      updated_at: ts,
      refs,
    },
  }, 201);
}
