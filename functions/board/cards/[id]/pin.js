// functions/board/cards/[id]/pin.js
//
// POST /board/cards/:id/pin
//
// Body: { pinned: true | false }
//
// Pins or unpins the card. Pinned cards sort to the top of their
// module and don't auto-archive. Anyone who can see the card can pin.

import { one, run } from '../../../lib/db.js';
import { now } from '../../../lib/ids.js';

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
  const { env, request, params, data } = context;
  const user = data?.user;
  if (!user || !user.id) return json({ ok: false, error: 'unauthenticated' }, 401);

  const card = await one(env.DB, 'SELECT id FROM board_cards WHERE id = ?', [params.id]);
  if (!card) return json({ ok: false, error: 'Not found.' }, 404);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON.' }, 400);
  }

  const pinned = payload.pinned ? 1 : 0;

  await run(
    env.DB,
    'UPDATE board_cards SET pinned = ?, updated_at = ? WHERE id = ?',
    [pinned, now(), params.id]
  );

  return json({ ok: true, pinned: !!pinned });
}
