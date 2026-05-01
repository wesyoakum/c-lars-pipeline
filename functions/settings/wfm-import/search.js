// functions/settings/wfm-import/search.js
//
// POST /settings/wfm-import/search
// Body: { kind: 'client'|'lead'|'quote'|'job'|'staff', query: '...' }
//
// Returns up to MAX_RESULTS records matching the query. Shape matches
// /sample so the page can populate the same `samples` state and the
// existing commit flow Just Works.
//
// Strategy per kind:
//   client  → /client.api/search?query=X (native, fast)
//   lead    → /lead.api/current paginated, filter by Name/Description match
//   quote   → /quote.api/current paginated, filter by Name/Description/ID
//   job     → /job.api/current paginated, filter by Name/Description/ID
//   staff   → /staff.api/list (small), filter by Name/Email
//
// For non-client kinds, we walk a few pages of the "current" list
// since WFM has no native text search. Cheap enough at the user's
// scale (~hundreds of leads/quotes total).

import { hasRole } from '../../lib/auth.js';
import { apiGet, recordList } from '../../lib/wfm-client.js';

const MAX_RESULTS  = 25;
const MAX_LIST_PAGES = 5;          // cap the list-walk for non-search kinds
const LIST_PAGE_SIZE = 100;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

const KIND_CONFIG = {
  client: { primary: 'Client', plural: 'clients' },
  lead:   { primary: 'Lead',   plural: 'leads' },
  quote:  { primary: 'Quote',  plural: 'quotes' },
  job:    { primary: 'Job',    plural: 'jobs' },
  staff:  { primary: 'Staff',  plural: 'staff' },
};

function recordMatches(rec, qLower) {
  const fields = [
    rec.Name, rec.ID, rec.UUID, rec.Description, rec.Email, rec.Phone,
    rec.Client?.Name, rec.Contact?.Name, rec.Owner?.Name,
  ];
  for (const f of fields) {
    if (!f) continue;
    if (String(f).toLowerCase().includes(qLower)) return true;
  }
  return false;
}

async function searchClients(env, query) {
  const r = await apiGet(env, '/client.api/search?query=' + encodeURIComponent(query));
  if (!r.ok) throw new Error('client search failed: ' + r.status);
  return recordList(r.body, 'Client');
}

async function searchByListWalk(env, basePath, primaryKey, qLower) {
  const matches = [];
  for (let page = 1; page <= MAX_LIST_PAGES && matches.length < MAX_RESULTS; page++) {
    const sep = basePath.includes('?') ? '&' : '?';
    const r = await apiGet(env, basePath + sep + 'page=' + page + '&pageSize=' + LIST_PAGE_SIZE);
    if (!r.ok) break;
    const arr = recordList(r.body, primaryKey);
    if (arr.length === 0) break;
    for (const rec of arr) {
      if (recordMatches(rec, qLower)) matches.push(rec);
      if (matches.length >= MAX_RESULTS) break;
    }
    if (arr.length < LIST_PAGE_SIZE) break;   // last page reached
  }
  return matches;
}

export async function onRequestPost(context) {
  const { env, request, data } = context;
  const user = data?.user;
  if (!user) return json({ ok: false, error: 'sign_in_required' }, 401);
  if (!hasRole(user, 'admin')) return json({ ok: false, error: 'admin_only' }, 403);

  let body = {};
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const kind  = String(body.kind || '').toLowerCase();
  const query = String(body.query || '').trim();
  if (!query) return json({ ok: false, error: 'query_required' }, 400);
  const cfg = KIND_CONFIG[kind];
  if (!cfg) return json({ ok: false, error: 'bad_kind', allowed: Object.keys(KIND_CONFIG) }, 400);

  try {
    let results = [];
    const qLower = query.toLowerCase();

    if (kind === 'client') {
      // Native search endpoint — also do a Name-substring fallback in
      // case BlueRock's search is exact-match or returns nothing.
      try { results = await searchClients(env, query); }
      catch (_) { /* fall through to list-walk */ }
      if (results.length === 0) {
        results = await searchByListWalk(env, '/client.api/list', 'Client', qLower);
      }
    } else if (kind === 'staff') {
      const r = await apiGet(env, '/staff.api/list');
      if (!r.ok) throw new Error('staff list failed: ' + r.status);
      const all = recordList(r.body, 'Staff');
      results = all.filter((rec) => recordMatches(rec, qLower));
    } else {
      // lead / quote / job — walk /current
      const basePath = '/' + kind + '.api/current';
      results = await searchByListWalk(env, basePath, cfg.primary, qLower);
    }

    results = results.slice(0, MAX_RESULTS);

    return json({
      ok: true,
      kind,
      query,
      samples: { [cfg.plural]: results },
      count: results.length,
      truncated: results.length === MAX_RESULTS,
    });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, 500);
  }
}
