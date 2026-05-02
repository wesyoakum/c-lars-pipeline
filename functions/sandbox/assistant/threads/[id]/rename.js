// functions/sandbox/assistant/threads/[id]/rename.js
//
// POST /sandbox/assistant/threads/:id/rename
//
// Form body: title (string).
//
// Wes-only. Validates the thread belongs to the caller. Returns the
// updated thread row's HTML for HTMX outerHTML swap on the sidebar
// entry, so the rename feels instant without reloading the page.

import { one, run } from '../../../../lib/db.js';
import { now } from '../../../../lib/ids.js';
import { formBody } from '../../../../lib/http.js';
import { renderThreadRow } from '../../../../lib/claudia-threads-render.js';

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';
const TITLE_MAX_LEN = 80;

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

  const form = await formBody(request);
  const raw = String(form.title || '').trim();
  // Empty title falls back to the default so the sidebar never shows a
  // blank row. Long titles get truncated at the cap.
  const title = raw.slice(0, TITLE_MAX_LEN) || 'New chat';

  const ts = now();
  await run(
    env.DB,
    'UPDATE assistant_threads SET title = ?, updated_at = ? WHERE id = ?',
    [title, ts, id]
  );

  // Re-fetch the row so the rendered HTML reflects the canonical state
  // (title + updated_at + message count).
  const url = new URL(request.url);
  const activeThreadId = url.searchParams.get('active') || id;
  const fresh = await one(
    env.DB,
    `SELECT t.id, t.title, t.updated_at,
            (SELECT COUNT(*) FROM assistant_messages WHERE thread_id = t.id) AS message_count
       FROM assistant_threads t
      WHERE t.id = ?`,
    [id]
  );
  return new Response(String(renderThreadRow(fresh, activeThreadId)), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
