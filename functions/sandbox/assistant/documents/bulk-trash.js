// functions/sandbox/assistant/documents/bulk-trash.js
//
// POST /sandbox/assistant/documents/bulk-trash
//
// Body: application/x-www-form-urlencoded with one or more `ids` fields.
//   ids=<doc_id_1>&ids=<doc_id_2>&...
// Or JSON: { ids: ["a", "b", ...] }
//
// Soft-deletes all matching rows owned by Wes (retention='trashed',
// trashed_at=now). Same retention semantics as the per-row × button —
// rows stay in the DB; nothing is purged.
//
// Returns JSON: { ok: true, trashed: N } so the inbox client JS can
// just remove the selected rows from the DOM and update the count
// without a full reload.

import { run } from '../../../lib/db.js';
import { now } from '../../../lib/ids.js';

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';
const MAX_IDS_PER_REQUEST = 500;

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user || user.email !== SANDBOX_OWNER) {
    return new Response('Not found', { status: 404 });
  }

  let ids = [];
  const ct = (request.headers.get('content-type') || '').toLowerCase();
  try {
    if (ct.includes('application/json')) {
      const body = await request.json();
      ids = Array.isArray(body?.ids) ? body.ids : [];
    } else {
      const form = await request.formData();
      ids = form.getAll('ids');
    }
  } catch (err) {
    return jsonResponse({ ok: false, error: 'bad request: ' + (err?.message || err) }, 400);
  }

  ids = ids
    .map((s) => String(s || '').trim())
    .filter(Boolean);

  if (ids.length === 0) {
    return jsonResponse({ ok: false, error: 'no ids supplied' }, 400);
  }
  if (ids.length > MAX_IDS_PER_REQUEST) {
    return jsonResponse({ ok: false, error: `too many ids (${ids.length} > ${MAX_IDS_PER_REQUEST})` }, 400);
  }

  const ts = now();
  const placeholders = ids.map(() => '?').join(',');
  const result = await run(
    env.DB,
    `UPDATE claudia_documents
        SET retention = 'trashed',
            updated_at = ?,
            trashed_at = ?
      WHERE user_id = ?
        AND retention != 'trashed'
        AND id IN (${placeholders})`,
    [ts, ts, user.id, ...ids]
  );

  // D1's `result.meta.changes` reflects rows actually updated (skipping
  // already-trashed and any IDs that didn't belong to the user).
  const trashed = result?.meta?.changes ?? 0;
  return jsonResponse({ ok: true, trashed });
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
