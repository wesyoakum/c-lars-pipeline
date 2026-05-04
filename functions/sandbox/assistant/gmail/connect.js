// functions/sandbox/assistant/gmail/connect.js
//
// GET /sandbox/assistant/gmail/connect
//
// Wes-only. Builds the Google OAuth consent URL (with our client id +
// redirect uri + scopes) and 302-redirects to it. Google will redirect
// back to /sandbox/assistant/gmail/callback?code=<...>.
//
// state carries the user_id so the callback can verify the response
// matches the originating user. It's not signed (we trust Google not
// to leak the redirect URL), but it's the standard CSRF mitigation
// hook should we want to add HMAC later.

import { buildAuthUrl } from '../../../lib/gmail-oauth.js';

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user || user.email !== SANDBOX_OWNER) {
    return new Response('Not found', { status: 404 });
  }
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET) {
    return new Response(
      'Gmail OAuth client not configured. Set GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET ' +
      'via `npx wrangler pages secret put`.',
      { status: 500 }
    );
  }
  const url = new URL(request.url);
  const redirectUri = `${url.origin}/sandbox/assistant/gmail/callback`;
  const authUrl = buildAuthUrl(env, {
    redirectUri,
    state: user.id,
  });
  return Response.redirect(authUrl, 302);
}
