// functions/sandbox/assistant/threads/[id]/delete.js
//
// POST /sandbox/assistant/threads/:id/delete
//
// Wes-only. Cascade-deletes the thread + all its messages
// (assistant_messages.thread_id has ON DELETE CASCADE).
//
// Returns:
//   - HX-Redirect to /sandbox/assistant if the deleted thread was the
//     ACTIVE one (caller marks this via hidden input `active=1`), so
//     the chat surface flips to the most-recent-remaining thread.
//   - Empty 200 (HTMX swaps it into nothing) when deleting a non-
//     active row from the sidebar — the row just vanishes.

import { one, run } from '../../../../lib/db.js';

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';

export async function onRequestPost(context) {
  const { env, data, params, request } = context;
  const user = data?.user;
  if (!user || user.email !== SANDBOX_OWNER) {
    return new Response('Not found', { status: 404 });
  }

  const id = String(params?.id || '').trim();
  if (!id) return new Response('Missing id', { status: 400 });

  const owned = await one(
    env.DB,
    'SELECT id FROM assistant_threads WHERE id = ? AND user_id = ?',
    [id, user.id]
  );
  if (!owned) return new Response('Not found', { status: 404 });

  await run(env.DB, 'DELETE FROM assistant_threads WHERE id = ?', [id]);

  // The form passes ?was_active=1 in the URL when the user is deleting
  // the thread they're currently viewing. We need to navigate them to
  // a sibling so the chat surface doesn't render against a dead id.
  const url = new URL(request.url);
  const wasActive = url.searchParams.get('was_active') === '1';
  if (wasActive) {
    return new Response(null, {
      status: 200,
      headers: { 'HX-Redirect': '/sandbox/assistant' },
    });
  }
  // Non-active delete: HTMX swaps the row out by replacing its HTML
  // with empty body.
  return new Response('', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
