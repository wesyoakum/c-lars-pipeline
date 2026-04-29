// functions/jobs/[id]/delete-preview.js
//
// GET /jobs/:id/delete-preview
// See lib/delete-preview.js for the response shape.

import { previewJobDelete } from '../../lib/delete-preview.js';

export async function onRequestGet(context) {
  const { env, params } = context;
  const preview = await previewJobDelete(env, params.id);
  if (!preview) {
    return new Response(JSON.stringify({ ok: false, error: 'not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(JSON.stringify({ ok: true, ...preview }), {
    headers: { 'content-type': 'application/json' },
  });
}
