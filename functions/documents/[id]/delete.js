// functions/documents/[id]/delete.js
//
// POST /documents/:id/delete — Soft-delete a document.
// R2 files are left in place (only purged on hard-delete or expiry sweep).

import { one, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { softDeleteStmt } from '../../lib/soft-delete.js';
import { now } from '../../lib/ids.js';
import { redirectWithFlash } from '../../lib/http.js';

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const docId = params.id;

  const doc = await one(env.DB, 'SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL', [docId]);
  if (!doc) return new Response('Not found', { status: 404 });

  const ts = now();
  await batch(env.DB, [
    auditStmt(env.DB, {
      entityType: 'document',
      entityId: docId,
      eventType: 'deleted',
      user,
      summary: `Deleted document: ${doc.title}`,
    }),
    softDeleteStmt(env.DB, 'documents', docId, ts),
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

  return redirectWithFlash(returnTo, `Deleted: ${doc.title}`, 'success', { undo: `/documents/${docId}/restore` });
}
