// functions/documents/resources/[id]/download.js
//
// GET /documents/resources/:id/download — Download a resource from R2.

import { one } from '../../../lib/db.js';

export async function onRequestGet(context) {
  const { env, params } = context;
  const resourceId = params.id;

  const resource = await one(
    env.DB,
    `SELECT id, title, original_filename, r2_key, mime_type FROM resources WHERE id = ?`,
    [resourceId]
  );

  if (!resource) {
    return new Response('Resource not found', { status: 404 });
  }

  const obj = await env.DOCS.get(resource.r2_key);
  if (!obj) {
    return new Response('File not found in storage', { status: 404 });
  }

  const filename = resource.original_filename || resource.title || 'resource';
  const safeFilename = filename.replace(/[^\w._-]+/g, '_');

  const headers = new Headers();
  headers.set('content-type', resource.mime_type || 'application/octet-stream');
  headers.set('content-disposition', `attachment; filename="${safeFilename}"`);

  return new Response(obj.body, { status: 200, headers });
}
