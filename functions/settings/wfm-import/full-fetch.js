// functions/settings/wfm-import/full-fetch.js
//
// POST /settings/wfm-import/full-fetch
//
// Walks every WFM list endpoint and returns the full record set —
// no filters, no limits. Used by the "Full import — fetch everything"
// button in the workbench. The browser then chunks the response into
// /commit calls of ~30 records each.
//
// Per-quote / per-client detail fetches happen lazily inside /commit
// (commit.js auto-fetches client detail when Contacts is missing,
// and syncQuoteLines fetches per-quote detail). That keeps the
// fetch step itself under the 30s Pages Functions wall clock.
//
// Total fetch time at C-LARS scale: ~5-15s for ~hundreds of records
// per kind. Returns ~2-5MB of JSON.
//
// Admin-only.

import { hasRole } from '../../lib/auth.js';
import { apiGet, recordList } from '../../lib/wfm-client.js';

const LIST_PAGE_SIZE = 100;
const SINGLE_SHOT_PAGE_SIZE = 1000;
const MAX_LIST_PAGES = 50;   // 50 * 100 = 5000-record cap. Way above C-LARS scale.

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

// Probe pagination: /client.api/list paginates and returns
// TotalRecords; /lead.api/current and /quote.api/current and
// /job.api/current return everything in one shot and ignore page=
// params. Pick the right strategy.
async function fetchKind(env, basePath, primaryKey) {
  const total = await readTotalRecords(env, basePath);
  if (total === null) {
    return await fetchSingleShot(env, basePath, primaryKey);
  }
  return await fetchAllPaginated(env, basePath, primaryKey);
}

export async function onRequestPost(context) {
  const { env, data } = context;
  const user = data?.user;
  if (!user) return json({ ok: false, error: 'sign_in_required' }, 401);
  if (!hasRole(user, 'admin')) return json({ ok: false, error: 'admin_only' }, 403);

  const startedAt = Date.now();

  try {
    // Run all five list endpoints in parallel. /staff.api/list is small,
    // /client.api/list paginates, the three /current endpoints are
    // single-shot. Promise.all gives us total wall clock = max of
    // the slowest, not the sum.
    const [staff, clients, leads, quotes, jobs] = await Promise.all([
      apiGet(env, '/staff.api/list').then((r) => r.ok ? recordList(r.body, 'Staff') : []),
      fetchKind(env, '/client.api/list',   'Client'),
      fetchKind(env, '/lead.api/current',  'Lead'),
      fetchKind(env, '/quote.api/current', 'Quote'),
      fetchKind(env, '/job.api/current',   'Job'),
    ]);

    return json({
      ok: true,
      samples: { staff, clients, leads, quotes, jobs },
      counts: {
        staff: staff.length,
        clients: clients.length,
        leads: leads.length,
        quotes: quotes.length,
        jobs: jobs.length,
        total: staff.length + clients.length + leads.length + quotes.length + jobs.length,
      },
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    return json({
      ok: false,
      error: String(err.message || err),
      duration_ms: Date.now() - startedAt,
    }, 500);
  }
}
