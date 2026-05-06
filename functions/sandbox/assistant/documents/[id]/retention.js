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
    `SELECT d.id, d.filename, d.content_type, d.size_bytes, d.retention,
            d.extraction_status, d.extraction_error, d.created_at,
            d.category,
            d.sender_email, d.sender_name, d.subject, d.email_date,
            d.parent_id,
            substr(coalesce(d.full_text, ''), 1, 200) AS preview,
            COALESCE(
              (SELECT p.created_at FROM claudia_documents p WHERE p.id = d.parent_id),
              d.created_at
            ) AS sort_anchor
       FROM claudia_documents d
      WHERE d.user_id = ? AND d.retention != 'trashed'
      ORDER BY sort_anchor DESC,
               (d.parent_id IS NULL) DESC,
               d.created_at ASC
      LIMIT 60`,
    [user.id]
  );

  return new Response(renderDocumentsPanel(docs), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
