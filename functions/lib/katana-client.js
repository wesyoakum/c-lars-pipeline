// functions/lib/katana-client.js
//
// Minimal server-side Katana API client.
//
// Auth model (much simpler than wfm-client.js): a single static API
// key stored as a Pages secret named KATANA_API_KEY. No OAuth, no
// refresh-token rotation, no per-tenant header — just
//   Authorization: Bearer <key>
//
// To set the secret (one-time, or whenever the user rotates it in
// Katana → Settings → API):
//   echo '<key>' | npx wrangler pages secret put KATANA_API_KEY --project-name=c-lars-pms
//
// The OpenAPI spec lives at https://api.katanamrp.com/v1/openapi.json
// (saved locally at tmp/katana-openapi.json for offline reference).
//
// Phase 1 of the integration is read-only: the /settings/katana-probe
// page just hits a few GET endpoints to confirm the connection works
// and to surface what the user's existing Katana data looks like
// (products, customers, tax rates, locations) before we design the
// won-opp → sales-order push flow.

const API_BASE = 'https://api.katanamrp.com/v1';

/**
 * Fetch an API key from env, throwing a typed error if missing.
 */
function requireApiKey(env) {
  const key = env.KATANA_API_KEY;
  if (!key) {
    const err = new Error('Katana is not connected. Set KATANA_API_KEY via `wrangler pages secret put`.');
    err.code = 'no_api_key';
    throw err;
  }
  return key;
}

/**
 * GET request against the Katana REST API.
 *
 * @param {object}   env             Pages Functions env bindings
 * @param {string}   pathOrUrl       Path (e.g. '/products') or full URL
 * @param {object}   [opts]
 * @param {object}   [opts.query]    Query parameters (object → URLSearchParams)
 * @returns {Promise<{ok, status, body, rawText, contentType, durationMs, url}>}
 */
export async function apiGet(env, pathOrUrl, opts = {}) {
  const apiKey = requireApiKey(env);

  let url = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : API_BASE + (pathOrUrl.startsWith('/') ? pathOrUrl : '/' + pathOrUrl);

  if (opts.query && typeof opts.query === 'object') {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v === null || v === undefined || v === '') continue;
      if (Array.isArray(v)) {
        // Katana accepts repeated `ids=` style for arrays.
        for (const item of v) params.append(k, String(item));
      } else {
        params.set(k, String(v));
      }
    }
    const qs = params.toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }

  const headers = {
    accept:        'application/json',
    authorization: 'Bearer ' + apiKey,
  };

  const started = Date.now();
  const res = await fetch(url, { method: 'GET', headers });
  const text = await res.text();
  const contentType = (res.headers.get('content-type') || '').toLowerCase();

  let body = text;
  if (contentType.includes('json') || (text && text.trim().startsWith('{'))) {
    try { body = JSON.parse(text); } catch { /* fall through */ }
  }

  return {
    ok: res.ok,
    status: res.status,
    body,
    rawText: text,
    contentType,
    durationMs: Date.now() - started,
    url,
  };
}

/**
 * Convenience: pull the `data` array out of a list response. Katana
 * list endpoints return `{ data: [...], pagination: {...} }`. Returns
 * an empty array if the body shape doesn't match.
 */
export function listRecords(body) {
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.data)) return body.data;
  return [];
}
