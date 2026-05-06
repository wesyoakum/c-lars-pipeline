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

  // D1 caps bound parameters at ~100 per statement (much tighter than
  // SQLite's 999). With 3 fixed params (ts, ts, user.id) we have ~97
  // slots for IDs. Chunk well under that to leave headroom and to
  // avoid long-running statements on large batches. Each chunk's
  // UPDATE is independent — already-trashed rows from a prior chunk
  // are no-ops (the WHERE retention != 'trashed' clause), so a retry
  // mid-batch is safe.
  const CHUNK_SIZE = 50;
  const ts = now();
  let trashed = 0;

  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    let meta;
    try {
      // db.js's run() already unwraps to result.meta for us, so the
      // returned object IS the meta — `meta.changes` directly, NOT
      // `meta.meta.changes`.
      meta = await run(
        env.DB,
        `UPDATE claudia_documents
            SET retention = 'trashed',
                updated_at = ?,
                trashed_at = ?
          WHERE user_id = ?
            AND retention != 'trashed'
            AND id IN (${placeholders})`,
        [ts, ts, user.id, ...chunk]
      );
    } catch (err) {
      console.error('[bulk-trash] sql error on chunk', i, '–', i + chunk.length, ':',
        err?.message || err, 'ids count:', ids.length);
      return jsonResponse({
        ok: false,
        // Even on partial failure, report what we did manage to trash
        // so the client can refresh accurately.
        error: 'sql: ' + (err?.message || String(err)),
        trashed,
      }, 500);
    }
    trashed += meta?.changes ?? 0;
  }

  return jsonResponse({ ok: true, trashed });
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
