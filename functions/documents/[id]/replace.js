// functions/documents/[id]/replace.js
//
// POST /documents/:id/replace — Replace the file for an existing document.
// Keeps the same title but updates filename, r2_key, mime_type, size, timestamp.

import { one, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { uuid, now } from '../../lib/ids.js';
import { buildR2Key, uploadToR2, deleteFromR2 } from '../../lib/r2.js';
import { redirectWithFlash } from '../../lib/http.js';

const MAX_SIZE = 50 * 1024 * 1024;

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const docId = params.id;

  const doc = await one(env.DB, 'SELECT * FROM documents WHERE id = ?', [docId]);
  if (!doc) return new Response('Not found', { status: 404 });

  let formData;
  try { formData = await request.formData(); } catch {
    return redirectWithFlash('/', 'Invalid form data.', 'error');
  }

  const file = formData.get('file');
  const returnTo = formData.get('return_to') || '/';

  if (!file || typeof file === 'string' || file.size === 0) {
    return redirectWithFlash(returnTo, 'No file selected.', 'error');
  }
  if (file.size > MAX_SIZE) {
    return redirectWithFlash(returnTo, 'File exceeds 50 MB limit.', 'error');
  }

  const ts = now();
  const originalFilename = file.name || 'file';
  const oppId = doc.opportunity_id || 'general';
  const newR2Key = buildR2Key(oppId, originalFilename);

  // Upload new file to R2
  await uploadToR2(env.DOCS, newR2Key, file, {
    documentId: docId,
    uploadedBy: user?.email ?? 'unknown',
    kind: doc.kind,
  });

  // Delete old R2 object (best-effort)
  if (doc.r2_key && doc.r2_key !== newR2Key) {
    try { await deleteFromR2(env.DOCS, doc.r2_key); } catch {}
  }

  // Update metadata — keep original title
  await batch(env.DB, [
    stmt(env.DB,
      `UPDATE documents
          SET original_filename = ?, r2_key = ?, mime_type = ?,
              size_bytes = ?, uploaded_at = ?, uploaded_by_user_id = ?
        WHERE id = ?`,
      [originalFilename, newR2Key, file.type || 'application/octet-stream',
       file.size, ts, user?.id, docId]),
    auditStmt(env.DB, {
      entityType: 'document',
      entityId: docId,
      eventType: 'replaced',
      user,
      summary: `Replaced file for "${doc.title}" with ${originalFilename}`,
      changes: {
        original_filename: { from: doc.original_filename, to: originalFilename },
        size_bytes: { from: doc.size_bytes, to: file.size },
      },
    }),
  ]);

  return redirectWithFlash(returnTo, `Replaced: ${doc.title}`);
}
