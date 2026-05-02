// functions/sandbox/assistant/documents/[id]/retention.js
//
// POST /sandbox/assistant/documents/:id/retention?to=<auto|keep_forever|trashed>
//
// Updates a single document's retention. Returns the refreshed full
// documents-panel HTML for HTMX to swap in via outerHTML on
// #claudia-docs-panel. Wes-only.

import { all, run } from '../../../../lib/db.js';
import { now } from '../../../../lib/ids.js';
import { renderDocumentsPanel } from '../../../../lib/claudia-documents-render.js';

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';
const ALLOWED = new Set(['auto', 'keep_forever', 'trashed']);

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  if (!user || user.email !== SANDBOX_OWNER) {
    return new Response('Not found', { status: 404 });
  }

  const docId = params.id;
  const to = new URL(request.url).searchParams.get('to');
  if (!docId || !ALLOWED.has(to)) {
    return new Response('Bad request', { status: 400 });
  }

  const ts = now();
  await run(
    env.DB,
    `UPDATE claudia_documents
        SET retention = ?,
            updated_at = ?,
            trashed_at = CASE WHEN ? = 'trashed' THEN ? ELSE NULL END
      WHERE id = ? AND user_id = ?`,
    [to, ts, to, ts, docId, user.id]
  );

  const docs = await all(
    env.DB,
    `SELECT id, filename, content_type, size_bytes, retention,
            extraction_status, extraction_error, created_at,
            substr(coalesce(full_text, ''), 1, 200) AS preview
       FROM claudia_documents
      WHERE user_id = ? AND retention != 'trashed'
      ORDER BY created_at DESC
      LIMIT 30`,
    [user.id]
  );

  return new Response(renderDocumentsPanel(docs), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
