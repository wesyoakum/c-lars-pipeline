// functions/documents/[id]/delete.js
//
// POST /documents/:id/delete — Remove a document from R2 + D1.

import { one, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { deleteFromR2 } from '../../lib/r2.js';
import { redirectWithFlash } from '../../lib/http.js';

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const docId = params.id;

  const doc = await one(env.DB, 'SELECT * FROM documents WHERE id = ?', [docId]);
  if (!doc) return new Response('Not found', { status: 404 });

  // Delete from R2 first (if R2 fails, we haven't deleted metadata yet)
  try {
    await deleteFromR2(env.DOCS, doc.r2_key);
  } catch (e) {
    // Log but don't block — the metadata should still be cleaned up
    console.error('R2 delete failed:', e);
  }

  // Delete metadata from D1
  await batch(env.DB, [
    stmt(env.DB, 'DELETE FROM documents WHERE id = ?', [docId]),
    auditStmt(env.DB, {
      entityType: 'document',
      entityId: docId,
      eventType: 'deleted',
      user,
      summary: `Deleted document: ${doc.title}`,
    }),
  ]);

  // Redirect back to referrer
  const referer = request.headers.get('referer');
  let returnTo = '/';
  if (referer) {
    try { returnTo = new URL(referer).pathname; } catch {}
  }

  // Try form field first
  let formData;
  try { formData = await request.formData(); } catch {}
  const formReturn = formData?.get('return_to');
  if (formReturn) returnTo = formReturn;

  return redirectWithFlash(returnTo, `Deleted: ${doc.title}`);
}
