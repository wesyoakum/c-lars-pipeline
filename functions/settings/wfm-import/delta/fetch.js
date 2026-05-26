// functions/settings/wfm-import/delta/fetch.js
//
// POST /settings/wfm-import/delta/fetch
//
// Fetches a single WFM kind (client/lead/quote/job) and writes it
// to the R2 snapshot. Called by the browser once per kind to stay
// within the 30s Pages Functions timeout.
//
// Body: { snapshot_id, kind }
// Returns: { ok, kind, count }
//
// Admin-only.

import { hasRole } from '../../../lib/auth.js';
import { apiGet, recordList, getAccessToken } from '../../../lib/wfm-client.js';
import { writeSnapshotKind } from '../../../lib/wfm-snapshot.js';

const LIST_PAGE_SIZE = 100;
const SINGLE_SHOT_PAGE_SIZE = 1000;
const MAX_LIST_PAGES = 50;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function readTotalRecords(env, basePath) {
  const sep = basePath.includes('?') ? '&' : '?';
  const r = await apiGet(env, basePath + sep + 'page=1&pageSize=1');
  if (!r.ok) return null;
  const totalStr = r.body?.Response?.TotalRecords;
  if (!totalStr) return null;
  const n = parseInt(totalStr, 10);
  return Number.isNaN(n) ? null : n;
}

async function fetchAllPaginated(env, basePath, primaryKey) {
  const out = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const sep = basePath.includes('?') ? '&' : '?';
    const r = await apiGet(env, basePath + sep + 'page=' + page + '&pageSize=' + LIST_PAGE_SIZE);
    if (!r.ok) break;
    const arr = recordList(r.body, primaryKey);
    if (arr.length === 0) break;
    for (const rec of arr) {
      const id = rec.UUID || rec.ID;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      out.push(rec);
    }
    if (arr.length < LIST_PAGE_SIZE) break;
  }
  return out;
}

async function fetchSingleShot(env, basePath, primaryKey) {
  const sep = basePath.includes('?') ? '&' : '?';
  const r = await apiGet(env, basePath + sep + 'pageSize=' + SINGLE_SHOT_PAGE_SIZE);
  if (!r.ok) return [];
  return recordList(r.body, primaryKey);
}

async function fetchKind(env, basePath, primaryKey) {
  const total = await readTotalRecords(env, basePath);
  if (total === null) return await fetchSingleShot(env, basePath, primaryKey);
  return await fetchAllPaginated(env, basePath, primaryKey);
}

const KIND_CONFIG = {
  client: { path: '/client.api/list',  key: 'Client' },
  lead:   { path: null, key: 'Lead' },   // needs date range
  quote:  { path: null, key: 'Quote' },
  job:    { path: null, key: 'Job' },
};

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user || !hasRole(user, 'admin')) return json({ error: 'admin only' }, 403);

  let body = {};
  try { body = await request.json(); } catch { /* empty */ }

  const snapshotId = body?.snapshot_id;
  const kind = body?.kind;
  if (!snapshotId || !kind) {
    return json({ ok: false, error: 'snapshot_id and kind required' }, 400);
  }
  if (!KIND_CONFIG[kind]) {
    return json({ ok: false, error: 'invalid kind: ' + kind }, 400);
  }

  try {
    await getAccessToken(env);

    const dateRange = 'from=2020-01-01&to=2027-12-31';
    const pathMap = {
      client: '/client.api/list',
      lead:   `/lead.api/list?${dateRange}`,
      quote:  `/quote.api/list?${dateRange}`,
      job:    `/job.api/list?${dateRange}`,
    };

    const records = await fetchKind(env, pathMap[kind], KIND_CONFIG[kind].key);

    // Write to R2 snapshot (list only — details fetched during diff for changed records).
    await writeSnapshotKind(env.DOCS, snapshotId, kind, { list: records, details: {} });

    return json({ ok: true, kind, count: records.length });
  } catch (err) {
    return json({ ok: false, error: err?.message || String(err) }, 500);
  }
}
