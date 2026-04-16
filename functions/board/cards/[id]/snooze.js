// functions/board/cards/[id]/snooze.js
//
// POST /board/cards/:id/snooze
//
// Body: { duration_minutes: 5 | 30 | 120 | 'tomorrow' }  OR  { until: ISO-8601 }
//
// Hides this specific card from its module until the given time. Any
// user who can see the card can snooze their own view of it — but for
// v1 we store a single snooze_until on the card itself (there's no
// per-user snooze state). That means snoozing a shared card hides it
// for everyone, which is fine for the early-solo-and-small-team usage.
// Will revisit if/when it becomes a problem.

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

function computeSnoozeUntil(payload) {
  if (payload && typeof payload.until === 'string') {
    const d = new Date(payload.until);
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  const mins = payload && payload.duration_minutes;
  const d = new Date();

  if (mins === 'tomorrow') {
    // Tomorrow 8am local. We store UTC, but since we don't know the
    // user's timezone reliably on the server, approximate as "24h from
    // now" — close enough for a sidebar snooze; a user who wants a
    // specific time can pick `until`.
    d.setDate(d.getDate() + 1);
    d.setHours(8, 0, 0, 0);
    return d.toISOString();
  }

  const n = Number(mins);
  if (!Number.isFinite(n) || n <= 0 || n > 60 * 24 * 7) return null;

  d.setMinutes(d.getMinutes() + n);
  return d.toISOString();
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

  const snoozeUntil = computeSnoozeUntil(payload);
  if (!snoozeUntil) return json({ ok: false, error: 'Invalid snooze duration.' }, 400);

  await run(
    env.DB,
    'UPDATE board_cards SET snooze_until = ?, updated_at = ? WHERE id = ?',
    [snoozeUntil, now(), params.id]
  );

  return json({ ok: true, snooze_until: snoozeUntil });
}

// Clearing a snooze: POST with { clear: true } OR DELETE.
export async function onRequestDelete(context) {
  const { env, params, data } = context;
  const user = data?.user;
  if (!user || !user.id) return json({ ok: false, error: 'unauthenticated' }, 401);

  await run(
    env.DB,
    'UPDATE board_cards SET snooze_until = NULL, updated_at = ? WHERE id = ?',
    [now(), params.id]
  );
  return json({ ok: true });
}
