// functions/documents/[id]/download.js
//
// GET /documents/:id/download — Stream a document from R2.

import { one } from '../../lib/db.js';
import { streamFromR2 } from '../../lib/r2.js';

export async function onRequestGet(context) {
  const { env, params } = context;
  const docId = params.id;

  const doc = await one(env.DB,
    'SELECT id, r2_key, title, mime_type FROM documents WHERE id = ?',
    [docId]);

  if (!doc) {
    return new Response('Document not found', { status: 404 });
  }

  const response = await streamFromR2(env.DOCS, doc.r2_key);

  if (response.status === 404) {
    return new Response('File not found in storage', { status: 404 });
  }

  // Set content-disposition so the browser downloads with the original name
  const headers = new Headers(response.headers);
  const safeName = (doc.title || 'file').replace(/[^\w.\-]/g, '_');
  headers.set('content-disposition', `attachment; filename="${safeName}"`);
  if (doc.mime_type) {
    headers.set('content-type', doc.mime_type);
  }

  return new Response(response.body, { status: 200, headers });
}
