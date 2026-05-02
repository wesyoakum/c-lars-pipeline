// functions/sandbox/assistant/threads/new.js
//
// POST /sandbox/assistant/threads/new
//
// Creates a new empty thread for Wes and 303-redirects to the chat UI
// pointed at it (?thread=<id>). The "+ New chat" button on the threads
// sidebar posts here. Wes-only (matches the rest of /sandbox).

import { run } from '../../../lib/db.js';
import { now, uuid } from '../../../lib/ids.js';

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';

export async function onRequestPost(context) {
  const { env, data } = context;
  const user = data?.user;
  if (!user || user.email !== SANDBOX_OWNER) {
    return new Response('Not found', { status: 404 });
  }

  const id = uuid();
  const ts = now();
  await run(
    env.DB,
    'INSERT INTO assistant_threads (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [id, user.id, 'New chat', ts, ts]
  );

  const url = `/sandbox/assistant?thread=${encodeURIComponent(id)}`;

  // HTMX-aware: when the form posts via hx-post, return an HX-Redirect
  // header so the browser swaps to the new thread cleanly. For
  // non-HTMX (form submit, curl), 303 to the same URL.
  if (context.request.headers.get('hx-request') === 'true') {
    return new Response(null, {
      status: 200,
      headers: { 'HX-Redirect': url },
    });
  }
  return new Response(null, { status: 303, headers: { Location: url } });
}
