// functions/lib/wfm-client.js
//
// Server-side analog of scripts/wfm/api-client.mjs. Lives inside
// Cloudflare Pages Functions so the WFM-import UI can talk to
// BlueRock without proxying through a Node CLI.
//
// Credential layout:
//   * env.WFM_CLIENT_ID, env.WFM_CLIENT_SECRET — set via
//     `npx wrangler pages secret put WFM_CLIENT_ID --project-name=c-lars-pms`
//     (and similar for the secret). Static, never change.
//   * wfm_credentials table (single-row, id=1) holds the rotating
//     refresh_token plus the cached access_token + expiry. The
//     refresh token rotates on every use; we persist the new one
//     immediately so the next refresh succeeds.
//   * The org_id (used as the `account_id` request header) is
//     extracted from the access-token JWT and cached alongside.
//
// First-time setup: the user does the OAuth bootstrap once via the
// Node CLI (api-client.mjs --bootstrap-token <code>), which writes
// the refresh token to .env.local. Then they call the
// `/settings/wfm-import/credentials` POST endpoint (or run a
// one-shot wrangler d1 execute) to seed wfm_credentials with the
// same value.

import { XMLParser } from 'fast-xml-parser';
import { one, run } from './db.js';

const xmlParser = new XMLParser({
  ignoreAttributes:    false,
  attributeNamePrefix: '@_',
  parseTagValue:       false,
  parseAttributeValue: false,
  trimValues:          true,
});

const TOKEN_URL     = 'https://oauth.workflowmax.com/oauth/token';
const API_BASE      = 'https://api.workflowmax2.com';
const SCOPES        = 'openid profile email workflowmax offline_access';
const TENANT_HEADER = 'account_id';

// ---------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------

export async function getAccessToken(env, { force = false } = {}) {
  const creds = await one(
    env.DB,
    `SELECT refresh_token, access_token, access_expires_at, org_id
       FROM wfm_credentials WHERE id = 1`
  );
  if (!creds || !creds.refresh_token) {
    const err = new Error('WFM is not connected. Set the refresh token first via /settings/wfm-import.');
    err.code = 'no_refresh_token';
    throw err;
  }

  if (!force && creds.access_token && creds.access_expires_at) {
    const expires = new Date(creds.access_expires_at).getTime();
    if (Number.isFinite(expires) && expires > Date.now() + 30_000) {
      return { access: creds.access_token, orgId: creds.org_id || '' };
    }
  }

  const clientId     = env.WFM_CLIENT_ID;
  const clientSecret = env.WFM_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const err = new Error('WFM_CLIENT_ID / WFM_CLIENT_SECRET not configured. Set via `npx wrangler pages secret put`.');
    err.code = 'no_oauth_app';
    throw err;
  }

  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     clientId,
    client_secret: clientSecret,
    refresh_token: creds.refresh_token,
    scope:         SCOPES,
  });
  // BlueRock rejects Basic auth on the token endpoint — body params only.
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    // BlueRock returns 400 with error="invalid_grant" when:
    //   - The refresh token was already used (reuse detected)
    //   - The refresh token is expired (60+ days old)
    //   - The refresh token was manually revoked
    // In all three cases the token in our D1 row is dead and there
    // is NOTHING we can do but force the user to re-bootstrap. Hammer
    // protection: clear the cached access AND refresh tokens so
    // subsequent callers fail fast with a typed RECONNECT_REQUIRED
    // error instead of pounding BlueRock with the dead value.
    const lower = String(text).toLowerCase();
    const isInvalidGrant = res.status === 400 && (
      lower.includes('invalid_grant') ||
      lower.includes('refresh token reuse detected') ||
      lower.includes('refresh token is invalid') ||
      lower.includes('refresh token has expired')
    );
    if (isInvalidGrant) {
      try {
        await run(
          env.DB,
          `UPDATE wfm_credentials
              SET access_token = NULL, access_expires_at = NULL,
                  refresh_token = NULL,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE id = 1`);
      } catch (_) { /* best-effort cleanup */ }
      const err = new Error('RECONNECT_REQUIRED: WFM refresh token is dead. Visit /settings/wfm-import → Reconnect to re-bootstrap. Underlying response: ' + text.slice(0, 300));
      err.code = 'reconnect_required';
      throw err;
    }
    throw new Error(`OAuth token refresh failed (${res.status}): ${text.slice(0, 500)}`);
  }
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw new Error(`OAuth response was not JSON: ${text.slice(0, 300)}`); }

  const access     = payload.access_token;
  const expiresIn  = Number(payload.expires_in) || 1800;
  const newRefresh = payload.refresh_token || creds.refresh_token;
  if (!access) {
    throw new Error(`OAuth response missing access_token: ${JSON.stringify(payload).slice(0, 300)}`);
  }

  const orgId = extractOrgIdFromJwt(decodeJwtPayload(access)) || creds.org_id || '';
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  // CRITICAL: at this point BlueRock has already rotated the refresh
  // token — the OLD one we just used is dead. If the D1 write below
  // fails, we lose the new token forever and the next refresh will
  // hit "Refresh token reuse detected" because we'll re-send a
  // BlueRock-invalidated value. So retry hard before bailing.
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await run(
        env.DB,
        `UPDATE wfm_credentials
            SET refresh_token = ?, access_token = ?, access_expires_at = ?,
                org_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = 1`,
        [newRefresh, access, expiresAt, orgId]
      );
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      // Brief backoff: 50, 200, 600 ms.
      const sleepMs = [50, 200, 600][attempt] || 600;
      await new Promise((r) => setTimeout(r, sleepMs));
    }
  }
  if (lastErr) {
    // The tokens we hold in memory are still valid for the rest of this
    // request even though we couldn't persist them. Surface a loud
    // error so the next request fails fast (and a human can re-auth)
    // rather than silently using a stale refresh_token next time.
    throw new Error(
      `OAuth tokens rotated but D1 write failed after retries — RECONNECT REQUIRED. ` +
      `Underlying error: ${String(lastErr.message || lastErr)}`
    );
  }

  return { access, orgId };
}

export function decodeJwtPayload(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '==='.slice(0, (4 - b64.length % 4) % 4);
    // Workers have atob() but not Buffer.
    return JSON.parse(atob(padded));
  } catch (_) { return null; }
}

export function extractOrgIdFromJwt(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const arrayCandidates = [
    'org_ids', 'orgIds', 'organization_ids', 'organisationIds',
    'account_ids', 'tenant_ids',
  ];
  for (const k of arrayCandidates) {
    const v = payload[k];
    if (Array.isArray(v) && v.length > 0) return String(v[0]);
  }
  for (const k of ['org_id','orgId','organization_id','organisationId','account_id','accountId','tenant_id','tenantId','tid']) {
    if (payload[k]) return String(payload[k]);
  }
  return '';
}

// ---------------------------------------------------------------------
// API GET (XML- or JSON-aware)
// ---------------------------------------------------------------------

export async function apiGet(env, pathOrUrl) {
  const { access, orgId } = await getAccessToken(env);
  const url = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : API_BASE + (pathOrUrl.startsWith('/') ? pathOrUrl : '/' + pathOrUrl);

  const headers = {
    accept:        'application/json',
    authorization: `Bearer ${access}`,
  };
  if (orgId) headers[TENANT_HEADER] = orgId;

  const started = Date.now();
  const res = await fetch(url, { method: 'GET', headers });
  const text = await res.text();
  const contentType = (res.headers.get('content-type') || '').toLowerCase();

  let body = text;
  let bodyFormat = 'text';
  if (contentType.includes('json') || (!contentType && text.trim().startsWith('{'))) {
    try { body = JSON.parse(text); bodyFormat = 'json'; }
    catch { /* fall through */ }
  } else if (contentType.includes('xml') || text.trim().startsWith('<')) {
    try { body = xmlParser.parse(text); bodyFormat = 'xml'; }
    catch { /* fall through */ }
  }

  return {
    ok: res.ok,
    status: res.status,
    body,
    rawText: text,
    contentType,
    bodyFormat,
    durationMs: Date.now() - started,
    url,
  };
}

// ---------------------------------------------------------------------
// Helpers — find arrays / records inside a parsed XML envelope
// ---------------------------------------------------------------------

export function findRecordArray(body, maxDepth = 5) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return null;
  function dfs(obj, depth) {
    if (depth > maxDepth || !obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) return v;
      if (v && typeof v === 'object') {
        const found = dfs(v, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }
  return dfs(body, 0);
}

// Walk Response → <Plural> → <Singular>[] for the records of a known
// list endpoint. Falls through to findRecordArray for anything else.
export function recordList(body, primaryKey) {
  if (!body || typeof body !== 'object') return [];
  const response = body.Response;
  if (!response || typeof response !== 'object') return [];
  for (const v of Object.values(response)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = v[primaryKey];
      if (Array.isArray(inner)) return inner;
      if (inner && typeof inner === 'object') return [inner];
    }
  }
  if (response[primaryKey]) {
    const v = response[primaryKey];
    return Array.isArray(v) ? v : [v];
  }
  return findRecordArray(body) || [];
}
