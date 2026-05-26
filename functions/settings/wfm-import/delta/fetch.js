// functions/settings/wfm-import/delta/fetch.js
//
// POST /settings/wfm-import/delta/fetch
//
// Two phases per kind:
//   { snapshot_id, kind, phase: 'list' }    — fetch WFM list, write to R2
//   { snapshot_id, kind, phase: 'details' } — fetch next batch of details, update R2
//
// The browser calls 'list' once, then loops 'details' until complete.
// Each request stays under 30s.
//
// Admin-only.

import { hasRole } from '../../../lib/auth.js';
import { apiGet, recordList, getAccessToken } from '../../../lib/wfm-client.js';
import {
  readSnapshotKind, writeSnapshotKind,
} from '../../../lib/wfm-snapshot.js';

const LIST_PAGE_SIZE = 100;
const SINGLE_SHOT_PAGE_SIZE = 1000;
const MAX_LIST_PAGES = 50;
const DETAIL_BATCH_SIZE = 15;

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

async function fetchKindList(env, basePath, primaryKey) {
  const total = await readTotalRecords(env, basePath);
  if (total === null) return await fetchSingleShot(env, basePath, primaryKey);
  return await fetchAllPaginated(env, basePath, primaryKey);
}

const KIND_META = {
  client: { listPath: '/client.api/list',  key: 'Client', detailPath: '/client.api/get/', singular: 'Client' },
  lead:   { listPath: null, key: 'Lead',   detailPath: '/lead.api/get/',   singular: 'Lead' },
  quote:  { listPath: null, key: 'Quote',  detailPath: '/quote.api/get/',  singular: 'Quote' },
  job:    { listPath: null, key: 'Job',    detailPath: '/job.api/get/',    singular: 'Job' },
};

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user || !hasRole(user, 'admin')) return json({ error: 'admin only' }, 403);

  let body = {};
  try { body = await request.json(); } catch { /* empty */ }

  const snapshotId = body?.snapshot_id;
  const kind = body?.kind;
  const phase = body?.phase || 'list';
  if (!snapshotId || !kind || !KIND_META[kind]) {
    return json({ ok: false, error: 'snapshot_id and valid kind required' }, 400);
  }

  try {
    await getAccessToken(env);
    const meta = KIND_META[kind];

    if (phase === 'list') {
      // Fetch the WFM list for this kind.
      const dateRange = 'from=2020-01-01&to=2027-12-31';
      const path = kind === 'client' ? meta.listPath : `/${kind}.api/list?${dateRange}`;
      const records = await fetchKindList(env, path, meta.key);

      // Write list to R2 (details empty — filled in by 'details' phase).
      await writeSnapshotKind(env.DOCS, snapshotId, kind, { list: records, details: {} });

      return json({
        ok: true, kind, phase: 'list',
        count: records.length,
        details_done: 0,
        details_total: records.length,
        complete: false,
      });
    }

    if (phase === 'details') {
      // Read current snapshot to find which details still need fetching.
      const current = await readSnapshotKind(env.DOCS, snapshotId, kind);
      if (!current || !current.list) {
        return json({ ok: false, error: 'Run list phase first for ' + kind }, 400);
      }

      const details = current.details || {};
      const remaining = current.list.filter(r => r.UUID && !details[r.UUID]);

      if (remaining.length === 0) {
        return json({
          ok: true, kind, phase: 'details',
          details_done: Object.keys(details).length,
          details_total: current.list.length,
          complete: true,
        });
      }

      // Fetch next batch of details.
      const batch = remaining.slice(0, DETAIL_BATCH_SIZE);
      for (const rec of batch) {
        const r = await apiGet(env, meta.detailPath + encodeURIComponent(rec.UUID));
        if (r.ok) {
          const detail = recordList(r.body, meta.singular)[0];
          if (detail) details[rec.UUID] = detail;
        }
      }

      // Write updated snapshot.
      await writeSnapshotKind(env.DOCS, snapshotId, kind, { list: current.list, details });

      const done = Object.keys(details).length;
      return json({
        ok: true, kind, phase: 'details',
        details_done: done,
        details_total: current.list.length,
        complete: done >= current.list.length,
      });
    }

    return json({ ok: false, error: 'invalid phase: ' + phase }, 400);
  } catch (err) {
    return json({ ok: false, error: err?.message || String(err) }, 500);
  }
}
