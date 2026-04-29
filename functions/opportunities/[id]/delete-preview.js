// functions/opportunities/[id]/delete-preview.js
//
// GET /opportunities/:id/delete-preview
// See lib/delete-preview.js for the response shape.

import { previewOpportunityDelete } from '../../lib/delete-preview.js';

export async function onRequestGet(context) {
  const { env, params } = context;
  const preview = await previewOpportunityDelete(env, params.id);
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
