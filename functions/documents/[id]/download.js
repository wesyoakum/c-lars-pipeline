// functions/documents/[id]/download.js
//
// GET /documents/:id/download — Stream a document from R2.
//
// Default disposition is `inline` for previewable types (PDF, image)
// so clicking a doc link in the UI opens it in the browser's built-in
// viewer (new tab). Other types stay `attachment` to preserve the
// open-in-Word workflow for .docx etc.
//
// Force download regardless via the `?download=1` query param —
// surfaced on the docs list as a small download icon next to the
// inline-open link.

import { one } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { streamFromR2 } from '../../lib/r2.js';

// MIME types that browsers render inline natively.
function isPreviewableMime(mime) {
  if (!mime) return false;
  const m = String(mime).toLowerCase();
  return m === 'application/pdf'
      || m.startsWith('image/')
      || m === 'text/plain'
      || m === 'text/html';
}

export async function onRequestGet(context) {
  const { env, data, params, request } = context;
  const user = data?.user;
  const docId = params.id;
  const url = new URL(request.url);
  const forceDownload = url.searchParams.get('download') === '1';

  const doc = await one(env.DB,
    'SELECT id, r2_key, title, original_filename, mime_type FROM documents WHERE id = ?',
    [docId]);

  if (!doc) {
    return new Response('Document not found', { status: 404 });
  }

  const response = await streamFromR2(env.DOCS, doc.r2_key);

  if (response.status === 404) {
    return new Response('File not found in storage', { status: 404 });
  }

  // Log the access (fire-and-forget — don't block the response).
  // Audit summary varies by intent so the history page can tell viewing
  // apart from downloading.
  const inline = !forceDownload && isPreviewableMime(doc.mime_type);
  context.waitUntil(auditStmt(env.DB, {
    entityType: 'document',
    entityId: docId,
    eventType: inline ? 'viewed' : 'downloaded',
    user,
    summary: (inline ? 'Viewed: ' : 'Downloaded: ') + doc.title,
  }).run());

  // Strip characters that would break the Content-Disposition quoted-
  // string syntax (double quote, backslash, line breaks). Configured
  // filenames like "C-LARS Quote 25-00042.pdf" survive with spaces
  // intact.
  const headers = new Headers(response.headers);
  const rawName = doc.original_filename || doc.title || 'file';
  const safeName = rawName.replace(/["\\\r\n]/g, '').trim() || 'file';
  headers.set(
    'content-disposition',
    `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`
  );
  if (doc.mime_type) {
    headers.set('content-type', doc.mime_type);
  }

  return new Response(response.body, { status: 200, headers });
}
