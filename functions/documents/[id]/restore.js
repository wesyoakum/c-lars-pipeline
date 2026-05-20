// functions/documents/[id]/restore.js
//
// POST /documents/:id/restore — undo a soft-deleted document.

import { one, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { restoreStmt } from '../../lib/soft-delete.js';
import { redirectWithFlash } from '../../lib/http.js';

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const docId = params.id;

  const doc = await one(
    env.DB,
    `SELECT id, title, opportunity_id, job_id FROM documents WHERE id = ? AND deleted_at IS NOT NULL`,
    [docId]
  );
  if (!doc) {
    return redirectWithFlash('/', 'Document not found or not deleted.', 'error');
  }

  await batch(env.DB, [
    restoreStmt(env.DB, 'documents', docId),
    auditStmt(env.DB, {
      entityType: 'document',
      entityId: docId,
      eventType: 'restored',
      user,
      summary: `Restored document: ${doc.title}`,
    }),
  ]);

  // Redirect back to referrer or a sensible default
  const referer = request.headers.get('referer');
  let returnTo = '/';
  if (referer) {
    try { returnTo = new URL(referer).pathname; } catch {}
  }

  return redirectWithFlash(returnTo, `Restored: ${doc.title}`);
}
