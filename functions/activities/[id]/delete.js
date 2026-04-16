// functions/activities/[id]/delete.js
//
// POST /activities/:id/delete — Delete an activity.
//
// If the activity is a note with attached images, any linked documents
// will be cleaned up via the ON DELETE CASCADE on documents.activity_id.
// We also remove the underlying R2 blobs before the cascade so we don't
// leave orphans behind.

import { one, all, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { formBody, redirectWithFlash } from '../../lib/http.js';
import { deleteFromR2 } from '../../lib/r2.js';

function wantsJson(request) {
  const a = request.headers.get('accept') || '';
  return a.includes('application/json') && !a.includes('text/html');
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const actId = params.id;
  const json = wantsJson(request);

  const act = await one(env.DB, 'SELECT * FROM activities WHERE id = ?', [actId]);
  if (!act) {
    if (json) return jsonResponse({ ok: false, error: 'Activity not found' }, 404);
    return new Response('Not found', { status: 404 });
  }

  // formBody is unavailable for JSON-mode bulk callers (no form body).
  // Skip return_to in JSON mode — bulk caller will reload after the loop.
  const input = json ? {} : await formBody(request);
  const returnTo = input.return_to || '/activities';

  // Collect any documents linked to this activity so we can clean up R2.
  // D1 will cascade-delete the document rows when we delete the activity.
  const linkedDocs = await all(
    env.DB,
    'SELECT id, r2_key FROM documents WHERE activity_id = ?',
    [actId]
  );
  for (const doc of linkedDocs) {
    if (!doc.r2_key) continue;
    try {
      await deleteFromR2(env.DOCS, doc.r2_key);
    } catch (e) {
      // Non-fatal — continue the delete even if R2 cleanup fails for one
      // object, otherwise we'd block note deletion on a transient R2 hiccup.
      console.warn('r2 delete failed for', doc.r2_key, e);
    }
  }

  const label = act.type === 'note'
    ? 'Note'
    : (act.subject || act.type);

  await batch(env.DB, [
    stmt(env.DB, 'DELETE FROM activities WHERE id = ?', [actId]),
    auditStmt(env.DB, {
      entityType: 'activity',
      entityId: actId,
      eventType: 'deleted',
      user,
      summary: `Deleted ${act.type}${act.subject ? ': ' + act.subject : ''}`,
    }),
  ]);

  if (json) return jsonResponse({ ok: true, id: actId });
  return redirectWithFlash(returnTo, `Deleted ${label}.`);
}
