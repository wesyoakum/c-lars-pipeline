#!/usr/bin/env node
//
// scripts/wfm/api-client.mjs
//
// Phase 0 of the WFM migration plan: minimal OAuth-2 client for the
// BlueRock WorkflowMax v2 API. Reads credentials from .env.local and
// exposes:
//
//   getAccessToken()         — refreshes the bearer token when needed
//   apiGet(path, opts)       — single GET, returns { status, headers, body }
//   apiGetAllPages(path, …)  — auto-paginates and concatenates results
//
// Plus a CLI mode:
//
//   node scripts/wfm/api-client.mjs --whoami
//     refreshes the token, decodes the JWT, prints the tenant + email
//     so you can sanity-check `.env.local` before running the probe.
//
//   node scripts/wfm/api-client.mjs --get /v2/clients?page=1&pageSize=1
//     runs an arbitrary GET. Useful while debugging the gap items
//     flagged in docs/wfm-api-oauth-setup.md (tenant header name,
//     pagination params, etc.).
//
// Environment variables (read from .env.local at the repo root):
//   WFM_CLIENT_ID
//   WFM_CLIENT_SECRET
//   WFM_REFRESH_TOKEN
//   WFM_TENANT_ID            — UUID of the C-LARS WFM org
//   WFM_OAUTH_TOKEN_URL      — defaults to https://oauth.workflowmax2.com/oauth/token
//   WFM_API_BASE             — defaults to https://api.workflowmax2.com
//   WFM_TENANT_HEADER_NAME   — defaults to xero-tenant-id (override if BlueRock renamed it)
//
// The refresh token rotates with every refresh per OAuth spec. We
// write the new value back to .env.local automatically so the next
// run uses the latest. (Required because the old refresh token gets
// invalidated immediately on use.)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const ENV_FILE = path.join(REPO_ROOT, '.env.local');

// ---------------------------------------------------------------------
// .env.local read / write
// ---------------------------------------------------------------------

function loadEnvLocal() {
  if (!fs.existsSync(ENV_FILE)) return {};
  const raw = fs.readFileSync(ENV_FILE, 'utf8');
  const out = {};
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    // Strip surrounding quotes if present.
    if ((v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function writeEnvLocalKeyValue(key, value) {
  // Read, mutate, write back. Preserve ordering and comments.
  let lines = [];
  if (fs.existsSync(ENV_FILE)) {
    lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
  }
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    if (k === key) {
      lines[i] = `${key}=${value}`;
      found = true;
      break;
    }
  }
  if (!found) lines.push(`${key}=${value}`);
  fs.writeFileSync(ENV_FILE, lines.join('\n'));
}

// Merge .env.local into process.env, but don't clobber values the user
// already has in their shell. The shell wins.
function applyEnvLocal() {
  const fromFile = loadEnvLocal();
  for (const [k, v] of Object.entries(fromFile)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

// ---------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------

function getConfig() {
  applyEnvLocal();

  const required = ['WFM_CLIENT_ID', 'WFM_CLIENT_SECRET', 'WFM_REFRESH_TOKEN'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Missing env vars: ${missing.join(', ')}. ` +
      `Add them to .env.local at the repo root. See docs/wfm-api-oauth-setup.md.`
    );
  }

  return {
    clientId:        process.env.WFM_CLIENT_ID,
    clientSecret:    process.env.WFM_CLIENT_SECRET,
    refreshToken:    process.env.WFM_REFRESH_TOKEN,
    tenantId:        process.env.WFM_TENANT_ID || '',
    tokenUrl:        process.env.WFM_OAUTH_TOKEN_URL || 'https://oauth.workflowmax2.com/oauth/token',
    apiBase:         process.env.WFM_API_BASE || 'https://api.workflowmax2.com',
    tenantHeaderName: process.env.WFM_TENANT_HEADER_NAME || 'xero-tenant-id',
  };
}

// ---------------------------------------------------------------------
// OAuth: refresh-token grant
// ---------------------------------------------------------------------

let _cachedAccessToken = null;
let _cachedTokenExpiresAt = 0;

export async function getAccessToken({ force = false } = {}) {
  if (!force && _cachedAccessToken && Date.now() < _cachedTokenExpiresAt - 30_000) {
    return _cachedAccessToken;
  }
  const cfg = getConfig();
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: cfg.refreshToken,
  });
  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `OAuth token refresh failed (${res.status}): ${text.slice(0, 500)}`
    );
  }
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw new Error(`OAuth response was not JSON: ${text.slice(0, 300)}`); }

  const access = payload.access_token;
  const expiresIn = Number(payload.expires_in) || 1800;
  if (!access) {
    throw new Error(`OAuth response missing access_token: ${JSON.stringify(payload)}`);
  }
  _cachedAccessToken = access;
  _cachedTokenExpiresAt = Date.now() + expiresIn * 1000;

  // BlueRock rotates the refresh token on each use. Persist the new
  // one so the next run can authenticate.
  if (payload.refresh_token && payload.refresh_token !== cfg.refreshToken) {
    writeEnvLocalKeyValue('WFM_REFRESH_TOKEN', payload.refresh_token);
    process.env.WFM_REFRESH_TOKEN = payload.refresh_token;
  }
  return access;
}

// Decode a JWT without verifying. We only use this to sanity-check
// the tenant ID — never trust the contents for authorization decisions.
export function decodeJwtPayload(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '==='.slice(0, (4 - b64.length % 4) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (_) { return null; }
}

// ---------------------------------------------------------------------
// Single GET
// ---------------------------------------------------------------------

export async function apiGet(pathOrUrl, opts = {}) {
  const cfg = getConfig();
  const token = await getAccessToken();
  const url = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : cfg.apiBase + (pathOrUrl.startsWith('/') ? pathOrUrl : '/' + pathOrUrl);

  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
  };
  if (cfg.tenantId) {
    headers[cfg.tenantHeaderName] = cfg.tenantId;
  }
  // Allow callers to override / supplement headers.
  Object.assign(headers, opts.headers || {});

  const started = Date.now();
  const res = await fetch(url, { method: 'GET', headers });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (_) { body = text; }
  return {
    ok: res.ok,
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body,
    durationMs: Date.now() - started,
    url,
  };
}

// ---------------------------------------------------------------------
// Paginated GET
// ---------------------------------------------------------------------

/**
 * Fetch every page of a list endpoint and return the concatenated array.
 *
 * BlueRock's exact pagination params are unconfirmed in public docs
 * (flagged in the setup walkthrough). We try `?page=N&pageSize=M` —
 * the most common JSON-API convention — and stop when:
 *   - the response body has zero items, OR
 *   - the response indicates the last page via a flag we recognize
 *     (`hasMore: false`, `is_last_page: true`, `next: null`, etc.), OR
 *   - we hit the safety cap of `maxPages` (default 200).
 *
 * Override the param names via `opts.pageParam` / `opts.pageSizeParam`
 * if the probe shows BlueRock uses different names.
 */
export async function apiGetAllPages(basePath, opts = {}) {
  const pageParam = opts.pageParam || 'page';
  const pageSizeParam = opts.pageSizeParam || 'pageSize';
  const pageSize = opts.pageSize || 100;
  const maxPages = opts.maxPages || 200;
  const itemsKey = opts.itemsKey || null;  // explicit override; auto-detect otherwise

  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = basePath.includes('?') ? '&' : '?';
    const url = `${basePath}${sep}${pageParam}=${page}&${pageSizeParam}=${pageSize}`;
    const res = await apiGet(url, opts);
    if (!res.ok) {
      throw new Error(
        `Page ${page} of ${basePath} failed (${res.status}): ` +
        `${typeof res.body === 'string' ? res.body : JSON.stringify(res.body)}`.slice(0, 500)
      );
    }
    const items = extractItems(res.body, itemsKey);
    if (!items || items.length === 0) break;
    all.push(...items);
    if (items.length < pageSize) break;
    if (looksLikeLastPage(res.body)) break;
  }
  return all;
}

function extractItems(body, explicitKey) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  if (explicitKey && Array.isArray(body[explicitKey])) return body[explicitKey];
  // Heuristics: try a few common envelope shapes used across REST APIs.
  for (const k of ['data', 'items', 'results', 'records', 'value']) {
    if (Array.isArray(body[k])) return body[k];
  }
  // Last-ditch: pick the first array-valued top-level key.
  for (const [, v] of Object.entries(body)) {
    if (Array.isArray(v)) return v;
  }
  return [];
}

function looksLikeLastPage(body) {
  if (!body || typeof body !== 'object') return false;
  if (body.hasMore === false) return true;
  if (body.has_more === false) return true;
  if (body.is_last_page === true) return true;
  if (body.next === null) return true;
  if (body.next_page === null) return true;
  return false;
}

// ---------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--whoami')) {
    const token = await getAccessToken({ force: true });
    const payload = decodeJwtPayload(token);
    console.log('OAuth refresh succeeded.');
    console.log('Access token (first 24 chars):', token.slice(0, 24) + '…');
    if (payload) {
      console.log('JWT payload (decoded, unverified):');
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log('Could not decode access token as a JWT (might be opaque).');
    }
    const cfg = getConfig();
    console.log(`API base:         ${cfg.apiBase}`);
    console.log(`Tenant header:    ${cfg.tenantHeaderName} = ${cfg.tenantId || '(not set)'}`);
    return;
  }

  const getIdx = argv.indexOf('--get');
  if (getIdx >= 0 && argv[getIdx + 1]) {
    const target = argv[getIdx + 1];
    const res = await apiGet(target);
    console.log(`GET ${res.url} → ${res.status} (${res.durationMs}ms)`);
    console.log('Headers:');
    for (const [k, v] of Object.entries(res.headers)) {
      if (/^x-(rate|request)/i.test(k) || /^date$/i.test(k) || /^retry/i.test(k)) {
        console.log(`  ${k}: ${v}`);
      }
    }
    console.log('Body (first 1500 chars):');
    const bodyStr = typeof res.body === 'string'
      ? res.body
      : JSON.stringify(res.body, null, 2);
    console.log(bodyStr.slice(0, 1500));
    if (bodyStr.length > 1500) console.log(`… (${bodyStr.length - 1500} more chars)`);
    return;
  }

  console.log(`Usage:
  node scripts/wfm/api-client.mjs --whoami
  node scripts/wfm/api-client.mjs --get <path-or-full-url>

Examples:
  node scripts/wfm/api-client.mjs --whoami
  node scripts/wfm/api-client.mjs --get /v2/clients?page=1&pageSize=1
  node scripts/wfm/api-client.mjs --get /v2/jobs?pageSize=2
`);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` ||
    process.argv[1].endsWith('api-client.mjs')) {
  main().catch((err) => {
    console.error('Fatal:', err.message);
    process.exitCode = 1;
  });
}
