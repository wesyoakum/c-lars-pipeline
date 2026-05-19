// functions/lib/mrpeasy-client.js
//
// Server-side MRPeasy REST client. MRPeasy is the MRP/ERP C-LARS used
// before WorkflowMax; the account is frozen but we want everything out
// of it (see docs/mrpeasy-mapping.md).
//
// Credential model — refreshingly simple vs. WFM:
//   * mrpeasy_credentials (single-row, id=1) holds api_key + api_secret.
//   * Auth is static HTTP Basic: base64(api_key:api_secret). No tokens,
//     no rotation, no refresh — set once in MRPeasy
//     (Settings → Integration → API access) and it stays valid until
//     the user regenerates it there.
//
// THE ONE HARD CONSTRAINT — serial requests only:
//   MRPeasy allows exactly ONE in-flight request per account. A second
//   concurrent call returns HTTP 429 "another request is running at the
//   same time." So every caller MUST await each apiGet() before issuing
//   the next. Never Promise.all() these. fetchAll() below is written
//   strictly sequentially for this reason, and apiGet() retries 429
//   with backoff as a safety net.
//
// Pagination: offset + limit query params, max 100/page. The response
// carries `Content-Range: items 0-99/1476`. HTTP 206 = more pages,
// 200 = last/only page.

import { one, run } from './db.js';

const DEFAULT_API_BASE = 'https://app.mrpeasy.com/rest/v1';
const PAGE_SIZE        = 100;     // MRPeasy hard cap
const MAX_429_RETRIES  = 5;
const BASE_BACKOFF_MS  = 750;

// ---------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------

export async function getCredentials(env) {
  const creds = await one(
    env.DB,
    `SELECT api_key, api_secret, api_base
       FROM mrpeasy_credentials WHERE id = 1`
  );
  if (!creds || !creds.api_key || !creds.api_secret) {
    const err = new Error('MRPeasy is not connected. Set the API key + secret first via /settings/mrpeasy-import.');
    err.code = 'no_credentials';
    throw err;
  }
  const base = (creds.api_base && creds.api_base.trim())
    || env.MRPEASY_API_BASE
    || DEFAULT_API_BASE;
  return {
    apiKey:    creds.api_key,
    apiSecret: creds.api_secret,
    apiBase:   base.replace(/\/+$/, ''),
  };
}

function basicAuthHeader(apiKey, apiSecret) {
  // Workers have btoa(); no Buffer.
  return 'Basic ' + btoa(apiKey + ':' + apiSecret);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------
// Single GET — serial, 429-aware
// ---------------------------------------------------------------------
//
// path: '/customers' (leading slash optional). opts.query: object of
// extra query params. opts.offset / opts.limit: pagination.
//
// Returns { ok, status, body, rangeStart, rangeEnd, total, url }.
// `total` is parsed from Content-Range when present (null otherwise).

export async function apiGet(env, path, opts = {}) {
  const { apiKey, apiSecret, apiBase } = opts._creds || await getCredentials(env);

  const p = path.startsWith('http')
    ? path
    : apiBase + (path.startsWith('/') ? path : '/' + path);

  const url = new URL(p);
  if (opts.query && typeof opts.query === 'object') {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  if (Number.isFinite(opts.offset)) url.searchParams.set('offset', String(opts.offset));
  if (Number.isFinite(opts.limit))  url.searchParams.set('limit',  String(opts.limit));

  const headers = {
    accept:        'application/json',
    authorization: basicAuthHeader(apiKey, apiSecret),
  };

  const started = Date.now();
  let lastStatus = 0;
  let lastText = '';

  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    const res = await fetch(url.toString(), { method: 'GET', headers });
    lastStatus = res.status;

    if (res.status === 429) {
      // Another request is running. Back off and retry — never give up
      // immediately, the exporter depends on this.
      if (attempt < MAX_429_RETRIES) {
        await sleep(BASE_BACKOFF_MS * Math.pow(2, attempt));
        continue;
      }
    }

    const text = await res.text();
    lastText = text;

    let body = text;
    if (text && (text.trim().startsWith('{') || text.trim().startsWith('['))) {
      try { body = JSON.parse(text); } catch { /* leave as text */ }
    }

    // Content-Range: "items 0-99/1476"
    let rangeStart = null, rangeEnd = null, total = null;
    const cr = res.headers.get('content-range') || res.headers.get('Content-Range');
    if (cr) {
      const m = cr.match(/items\s+(\d+)-(\d+)\/(\d+|\*)/i);
      if (m) {
        rangeStart = parseInt(m[1], 10);
        rangeEnd   = parseInt(m[2], 10);
        total      = m[3] === '*' ? null : parseInt(m[3], 10);
      }
    }

    return {
      ok: res.ok || res.status === 206,
      status: res.status,
      body,
      rawText: text,
      rangeStart, rangeEnd, total,
      durationMs: Date.now() - started,
      url: url.toString(),
    };
  }

  return {
    ok: false,
    status: lastStatus || 429,
    body: lastText,
    rawText: lastText,
    rangeStart: null, rangeEnd: null, total: null,
    durationMs: Date.now() - started,
    url: url.toString(),
    error: 'exhausted 429 retries (MRPeasy serial-request limit)',
  };
}

// ---------------------------------------------------------------------
// Fetch ALL pages of an entity — strictly sequential
// ---------------------------------------------------------------------
//
// Walks offset 0, PAGE_SIZE, 2*PAGE_SIZE, … until a short/empty page or
// the Content-Range total is reached. NEVER parallelizes (429 rule).
//
// onPage(arr, meta) optional callback per page (for streaming to R2
// without holding everything in memory). Returns { records, total,
// pages } — records is the full array unless onPage consumed them.

export async function fetchAll(env, path, opts = {}) {
  const creds = await getCredentials(env);
  const limit = opts.limit || PAGE_SIZE;
  const maxPages = opts.maxPages || 1000;       // safety ceiling
  const keep = opts.onPage ? false : true;

  const records = [];
  let offset = 0;
  let total = null;
  let pages = 0;

  for (let i = 0; i < maxPages; i++) {
    const r = await apiGet(env, path, {
      _creds: creds, offset, limit,
      query: opts.query,
    });
    if (!r.ok) {
      const err = new Error('MRPeasy ' + path + ' failed at offset ' + offset + ': HTTP ' + r.status);
      err.status = r.status;
      err.detail = typeof r.body === 'string' ? r.body.slice(0, 300) : r.body;
      throw err;
    }
    const arr = Array.isArray(r.body) ? r.body : [];
    pages++;
    if (r.total !== null) total = r.total;

    if (opts.onPage) await opts.onPage(arr, { offset, total, page: pages });
    if (keep) for (const rec of arr) records.push(rec);

    // Stop conditions: short page, empty page, or we've reached total.
    if (arr.length < limit) break;
    offset += limit;
    if (total !== null && offset >= total) break;
  }

  return { records, total: total === null ? (keep ? records.length : null) : total, pages };
}

// ---------------------------------------------------------------------
// Connection test — cheapest possible authenticated call
// ---------------------------------------------------------------------

export async function testConnection(env) {
  // Ask for a single customer record. 200/206 ⇒ creds + plan OK.
  // 401/403 ⇒ bad creds or plan tier. Anything else ⇒ surface raw.
  const r = await apiGet(env, '/customers', { limit: 1, offset: 0 });
  return {
    ok: r.ok,
    status: r.status,
    total: r.total,
    detail: r.ok ? null : (typeof r.body === 'string' ? r.body.slice(0, 300) : r.body),
  };
}

export async function markVerified(env) {
  await run(env.DB,
    `UPDATE mrpeasy_credentials
        SET last_verified_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at        = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = 1`);
}

export { DEFAULT_API_BASE, PAGE_SIZE };
