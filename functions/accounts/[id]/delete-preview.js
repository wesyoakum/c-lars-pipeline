// functions/accounts/[id]/delete-preview.js
//
// GET /accounts/:id/delete-preview
//
// Returns the JSON impact summary for deleting this account — what
// children exist, how many of each kind, and a sample of names.
// The cascade-delete modal renders this so the user knows what's
// about to be removed before they confirm.

import { previewAccountDelete } from '../../lib/delete-preview.js';

export async function onRequestGet(context) {
  const { env, params } = context;
  const preview = await previewAccountDelete(env, params.id);
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
