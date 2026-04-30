// functions/api/fake-names.js
//
// GET /api/fake-names → JSON catalog grouped by kind.
//
// Used by the wizard engine (js/wizard-modal.js) to populate
// placeholder examples in input prompts. Lazy-fetched on first use
// per page; cached on window.Pipeline.fakeNames so subsequent
// wizard opens don't re-query.

import { loadFakeNamesByKind } from '../lib/fake-names.js';

export async function onRequestGet(context) {
  const { env, data } = context;
  const user = data?.user;
  if (!user) {
    return new Response(JSON.stringify({ ok: false, error: 'unauthenticated' }), {
      status: 401, headers: { 'content-type': 'application/json' },
    });
  }
  const byKind = await loadFakeNamesByKind(env);
  return new Response(JSON.stringify({ ok: true, byKind }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Cache briefly so a wizard-heavy page doesn't refetch on
      // every open. Admin edits land within 60s.
      'cache-control': 'private, max-age=60',
    },
  });
}
