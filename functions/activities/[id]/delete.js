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

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const actId = params.id;

  const act = await one(env.DB, 'SELECT * FROM activities WHERE id = ?', [actId]);
  if (!act) return new Response('Not found', { status: 404 });

  const input = await formBody(request);
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

  return redirectWithFlash(returnTo, `Deleted ${label}.`);
}
