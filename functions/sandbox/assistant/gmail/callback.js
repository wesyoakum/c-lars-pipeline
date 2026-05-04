// functions/sandbox/assistant/gmail/callback.js
//
// GET /sandbox/assistant/gmail/callback
//
// Wes-only. Google redirects here after the consent screen with
// ?code=<...>&state=<user_id> (or ?error=<...> on user denial).
// We exchange the code for { access_token, refresh_token, ... },
// persist the tokens in gmail_oauth_tokens, then redirect to the
// settings page so Wes sees the new "Connected as <email>" state.

import { exchangeCodeForTokens, saveTokens } from '../../../lib/gmail-oauth.js';

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user || user.email !== SANDBOX_OWNER) {
    return new Response('Not found', { status: 404 });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errParam = url.searchParams.get('error');

  // User clicked "Cancel" on Google's consent page, or scope denied,
  // or anything that came back as ?error=. Redirect with a message.
  if (errParam) {
    return Response.redirect(
      `${url.origin}/settings/claudia?gmail=denied&reason=${encodeURIComponent(errParam)}`,
      303
    );
  }

  if (!code) {
    return new Response('Missing ?code in callback.', { status: 400 });
  }

  // state should match the user.id we sent on the connect step.
  // Strict mismatch → 400; missing → log and proceed (best effort,
  // we still own the auth context here).
  if (state && state !== user.id) {
    return new Response('OAuth state mismatch.', { status: 400 });
  }

  const redirectUri = `${url.origin}/sandbox/assistant/gmail/callback`;

  let bundle;
  try {
    bundle = await exchangeCodeForTokens(env, { code, redirectUri });
  } catch (err) {
    return Response.redirect(
      `${url.origin}/settings/claudia?gmail=error&reason=${encodeURIComponent(err.message || String(err))}`,
      303
    );
  }

  if (!bundle.refresh_token) {
    // This happens when the user has already granted consent and
    // Google omits the refresh token on subsequent grants. We
    // request prompt=consent specifically to avoid this, but
    // surface clearly if it slips through.
    return Response.redirect(
      `${url.origin}/settings/claudia?gmail=no_refresh_token`,
      303
    );
  }

  try {
    await saveTokens(env, user.id, bundle);
  } catch (err) {
    return Response.redirect(
      `${url.origin}/settings/claudia?gmail=save_error&reason=${encodeURIComponent(err.message || String(err))}`,
      303
    );
  }

  return Response.redirect(`${url.origin}/settings/claudia?gmail=connected`, 303);
}
