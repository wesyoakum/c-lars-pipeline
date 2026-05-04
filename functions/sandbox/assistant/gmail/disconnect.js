// functions/sandbox/assistant/gmail/disconnect.js
//
// POST /sandbox/assistant/gmail/disconnect
//
// Wes-only. Wipes stored Gmail tokens. Doesn't call Google's revoke
// endpoint — Wes can revoke directly from
// https://myaccount.google.com/permissions if he wants Google's side
// cleaned up too. Most uses are "I want to reconnect from scratch."

import { disconnectUser } from '../../../lib/gmail-oauth.js';

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user || user.email !== SANDBOX_OWNER) {
    return new Response('Not found', { status: 404 });
  }
  await disconnectUser(env, user.id);

  // HTMX-aware: when the disconnect button posts via hx-post, return
  // an HX-Redirect so the page navigates back to the settings tab and
  // the new "not connected" state renders cleanly. Plain form posts
  // get a 303 to the same URL.
  if (request.headers.get('hx-request') === 'true') {
    return new Response(null, {
      status: 200,
      headers: { 'HX-Redirect': '/settings/claudia?gmail=disconnected' },
    });
  }
  return new Response(null, {
    status: 303,
    headers: { Location: '/settings/claudia?gmail=disconnected' },
  });
}
