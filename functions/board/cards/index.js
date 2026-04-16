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
//     target_user_id: uuid,                       (required if scope='direct')
//     pinned:  bool                               (default false)
//   }
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

  let targetUserId = null;
  if (scope === 'direct') {
    targetUserId = (payload.target_user_id || '').toString();
    if (!targetUserId) return json({ ok: false, error: 'target_user_id required for direct scope.' }, 400);
    // Sanity-check the target exists and is active — otherwise the
    // recipient could never see the card.
    const target = await one(env.DB, 'SELECT id FROM users WHERE id = ? AND active = 1', [targetUserId]);
    if (!target) return json({ ok: false, error: 'Target user not found.' }, 400);
  }

  const color = normalizeColor(payload.color);
  const flag = normalizeFlag(payload.flag);
  const pinned = payload.pinned ? 1 : 0;

  const id = uuid();
  const ts = now();

  await run(
    env.DB,
    `INSERT INTO board_cards
       (id, author_user_id, scope, target_user_id, body, color, flag, pinned,
        snooze_until, archived_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    [id, user.id, scope, targetUserId, body, color, flag, pinned, ts, ts]
  );

  const refs = parseRefs(body);
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
