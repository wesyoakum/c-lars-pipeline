// functions/documents/resources/[id]/replace.js
//
// POST /documents/resources/:id/replace — Replace a resource's file in R2.
// Keeps the same D1 record but updates the file, filename, size, and mime type.

import { one, stmt, batch } from '../../../lib/db.js';
import { auditStmt } from '../../../lib/audit.js';
import { now } from '../../../lib/ids.js';

const MAX_SIZE = 50 * 1024 * 1024; // 50 MB

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const resourceId = params.id;

  const resource = await one(env.DB,
    'SELECT id, title, r2_key FROM resources WHERE id = ?',
    [resourceId]);

  if (!resource) {
    return respondBack(request, 'Resource not found.', 'error');
  }

  const formData = await request.formData();
  const file = formData.get('file');

  if (!file || typeof file === 'string' || file.size === 0) {
    return respondBack(request, 'No file selected.', 'error');
  }

  if (file.size > MAX_SIZE) {
    return respondBack(request, 'File exceeds 50 MB limit.', 'error');
  }

  const ts = now();
  const originalFilename = file.name || 'file';

  // Replace the file at the same R2 key
  const buffer = await file.arrayBuffer();
  await env.DOCS.put(resource.r2_key, buffer, {
    httpMetadata: {
      contentType: file.type || 'application/octet-stream',
    },
    customMetadata: {
      resourceId,
      uploadedBy: user?.email ?? 'unknown',
      originalFilename,
      replacedAt: ts,
    },
  });

  // Update D1 record
  await batch(env.DB, [
    stmt(env.DB,
      `UPDATE resources
          SET original_filename = ?, mime_type = ?,
              size_bytes = ?, uploaded_at = ?, uploaded_by_user_id = ?
        WHERE id = ?`,
      [originalFilename, file.type || 'application/octet-stream',
       file.size, ts, user?.id, resourceId]),
    auditStmt(env.DB, {
      entityType: 'resource',
      entityId: resourceId,
      eventType: 'replaced',
      user,
      summary: `Replaced file for "${resource.title}" with ${originalFilename} (${formatSize(file.size)})`,
    }),
  ]);

  return respondBack(request, `Replaced: ${resource.title}`);
}

function respondBack(request, message, level = 'success') {
  const referer = request.headers.get('referer') || '/documents/resources';
  const sep = referer.includes('?') ? '&' : '?';
  const url = `${referer}${sep}flash=${encodeURIComponent(message)}&flash_level=${level}`;
  return Response.redirect(url, 303);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
