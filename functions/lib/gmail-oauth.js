// functions/lib/gmail-oauth.js
//
// Google OAuth 2.0 token management for Claudia's Gmail tools.
//
// Configuration (Cloudflare Pages env vars / secrets):
//   GMAIL_CLIENT_ID      — public OAuth client id (env var, not secret)
//   GMAIL_CLIENT_SECRET  — secret, set via `wrangler pages secret put`
//
// Storage:
//   gmail_oauth_tokens table (single row per user, PK user_id)
//
// Flow:
//   1. /sandbox/assistant/gmail/connect builds the consent URL via
//      buildAuthUrl() and redirects Wes to Google.
//   2. Google redirects back to /sandbox/assistant/gmail/callback with
//      ?code=<...>. exchangeCodeForTokens() trades it for
//      { access_token, refresh_token, expires_in, scope, ... }.
//   3. We persist the row and decode `id_token` (if present) to capture
//      the connected email address.
//   4. Each Gmail tool call goes through getValidAccessToken(), which
//      returns the cached access_token if it has > 60s left, otherwise
//      refreshes via the refresh_token.
//
// Scopes:
//   - gmail.readonly: read messages, threads, labels, history, profile.
//   - calendar.events: read+write events on the user's calendars.
//   - calendar.readonly: list calendars (so Claudia can pick a non-
//     primary calendar by label / id).
//   No gmail send/modify. If we ever want gmail draft creation later,
//   request gmail.compose then. Re-consent is required after this
//   scope set changes — the connect endpoint forces prompt=consent.

import { one, run } from './db.js';
import { now } from './ids.js';

const GOOGLE_AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export const GMAIL_DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'openid',
  'email',
  'profile',
];

/**
 * Build the Google consent-screen URL Wes should be redirected to.
 *
 * - access_type=offline asks for a refresh_token (without it, we only
 *   get an access_token that dies in an hour).
 * - prompt=consent forces re-consent on every connect so we always
 *   get a fresh refresh_token (Google's behavior is to OMIT the
 *   refresh_token on subsequent consents unless prompt=consent).
 * - state carries the user_id round-trip so the callback can verify
 *   the response matches the originating user.
 */
export function buildAuthUrl(env, { redirectUri, state, scopes }) {
  const clientId = env.GMAIL_CLIENT_ID;
  if (!clientId) throw new Error('GMAIL_CLIENT_ID not configured.');
  const params = new URLSearchParams({
    client_id:     clientId,
    response_type: 'code',
    redirect_uri:  redirectUri,
    scope:         (scopes || GMAIL_DEFAULT_SCOPES).join(' '),
    access_type:   'offline',
    prompt:        'consent',
    state:         state || '',
    include_granted_scopes: 'true',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange the ?code=<...> from the OAuth callback for a token bundle.
 * Returns { access_token, refresh_token, expires_in, scope, id_token? }.
 */
export async function exchangeCodeForTokens(env, { code, redirectUri }) {
  const clientId     = env.GMAIL_CLIENT_ID;
  const clientSecret = env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET not configured.');
  }
  const body = new URLSearchParams({
    code,
    client_id:     clientId,
    client_secret: clientSecret,
    redirect_uri:  redirectUri,
    grant_type:    'authorization_code',
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Refresh an access_token using the stored refresh_token. Google
 * does NOT rotate refresh tokens on standard refresh, so we don't
 * persist a new one (the existing refresh_token stays valid until
 * revoked or — in Testing mode — expires after 7 days).
 *
 * Returns { access_token, expires_in, scope } from Google.
 */
export async function refreshAccessToken(env, refreshToken) {
  const clientId     = env.GMAIL_CLIENT_ID;
  const clientSecret = env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET not configured.');
  }
  const body = new URLSearchParams({
    client_id:     clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type:    'refresh_token',
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Refresh failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Persist a fresh token bundle for a user. Used by the OAuth callback.
 */
export async function saveTokens(env, userId, bundle) {
  const ts = now();
  const expiresAt = bundle.expires_in
    ? new Date(Date.now() + (bundle.expires_in * 1000)).toISOString()
    : null;
  // Decode the id_token to grab the email address (no signature verify
  // here — we trust Google over TLS for the immediate-callback case).
  const connectedEmail = bundle.id_token ? decodeJwtEmail(bundle.id_token) : null;
  await run(
    env.DB,
    `INSERT INTO gmail_oauth_tokens
       (user_id, refresh_token, access_token, access_expires_at,
        scopes, connected_email, connected_at, last_refreshed_at, last_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(user_id) DO UPDATE SET
       refresh_token     = excluded.refresh_token,
       access_token      = excluded.access_token,
       access_expires_at = excluded.access_expires_at,
       scopes            = excluded.scopes,
       connected_email   = excluded.connected_email,
       connected_at      = excluded.connected_at,
       last_refreshed_at = excluded.last_refreshed_at,
       last_error        = NULL`,
    [userId, bundle.refresh_token, bundle.access_token || null,
     expiresAt, bundle.scope || null, connectedEmail, ts, ts]
  );
}

/**
 * Get a valid access_token for a user, refreshing if needed. Throws
 * with code='gmail_not_connected' when no row exists, code='refresh_failed'
 * when the refresh hits an auth error (most commonly: refresh token
 * expired in Testing mode after 7 days, or revoked from Google account
 * settings). Callers surface those codes to Claudia, which surfaces
 * them to Wes as "Gmail needs to be reconnected."
 */
export async function getValidAccessToken(env, userId) {
  const row = await one(
    env.DB,
    `SELECT refresh_token, access_token, access_expires_at, connected_email
       FROM gmail_oauth_tokens WHERE user_id = ?`,
    [userId]
  );
  if (!row || !row.refresh_token) {
    const err = new Error('Gmail is not connected for this user.');
    err.code = 'gmail_not_connected';
    throw err;
  }
  // Use cached token if it's got > 60s left.
  if (row.access_token && row.access_expires_at) {
    const expires = Date.parse(row.access_expires_at);
    if (Number.isFinite(expires) && expires > Date.now() + 60_000) {
      return { accessToken: row.access_token, connectedEmail: row.connected_email };
    }
  }
  // Refresh.
  let bundle;
  try {
    bundle = await refreshAccessToken(env, row.refresh_token);
  } catch (err) {
    // Persist the error so the settings UI can show what went wrong.
    await run(
      env.DB,
      'UPDATE gmail_oauth_tokens SET last_error = ? WHERE user_id = ?',
      [String(err?.message || err).slice(0, 500), userId]
    );
    const wrapped = new Error('Gmail token refresh failed: ' + (err?.message || err));
    wrapped.code = 'refresh_failed';
    throw wrapped;
  }
  const ts = now();
  const expiresAt = bundle.expires_in
    ? new Date(Date.now() + (bundle.expires_in * 1000)).toISOString()
    : null;
  await run(
    env.DB,
    `UPDATE gmail_oauth_tokens
        SET access_token = ?, access_expires_at = ?,
            last_refreshed_at = ?, last_error = NULL
      WHERE user_id = ?`,
    [bundle.access_token, expiresAt, ts, userId]
  );
  return { accessToken: bundle.access_token, connectedEmail: row.connected_email };
}

/**
 * Decode the email claim from a JWT id_token. We don't verify the
 * signature here — only used during the immediate OAuth callback,
 * where we just exchanged with Google over TLS, so the source is
 * trusted. Production uses of id_tokens in other contexts SHOULD
 * verify signatures.
 */
function decodeJwtEmail(idToken) {
  try {
    const parts = String(idToken).split('.');
    if (parts.length !== 3) return null;
    // Convert base64url → base64 then decode.
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - payload.length % 4) % 4);
    const json = JSON.parse(atob(padded));
    return json.email || null;
  } catch {
    return null;
  }
}

/**
 * Wipe stored tokens for a user. Called by the disconnect endpoint.
 * Does not call Google's revocation endpoint (best-effort; the user
 * can also revoke from https://myaccount.google.com/permissions).
 */
export async function disconnectUser(env, userId) {
  await run(env.DB, 'DELETE FROM gmail_oauth_tokens WHERE user_id = ?', [userId]);
}

/**
 * Read connection state for a user — used by the settings UI to show
 * "connected as X / not connected / error needs reconnect."
 */
export async function getGmailConnectionStatus(env, userId) {
  const row = await one(
    env.DB,
    `SELECT connected_email, connected_at, last_refreshed_at, scopes, last_error
       FROM gmail_oauth_tokens WHERE user_id = ?`,
    [userId]
  );
  if (!row) return { connected: false };
  return {
    connected: true,
    connected_email: row.connected_email,
    connected_at: row.connected_at,
    last_refreshed_at: row.last_refreshed_at,
    scopes: row.scopes,
    last_error: row.last_error,
  };
}
