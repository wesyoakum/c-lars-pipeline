// functions/settings/wfm-import/search.js
//
// POST /settings/wfm-import/search
//
// Body (all keys optional except kind):
//   {
//     kind:    'client' | 'lead' | 'quote' | 'job' | 'staff',
//     query:   '...free-text substring across name/id/description...',
//     filters: {
//       // Date range — kind-specific date_field (see DATE_FIELDS_BY_KIND).
//       date_field: 'Date'|'ValidDate'|'DateWonLost'|'StartDate'|'DueDate'|
//                   'DateCreatedUtc'|'DateModifiedUtc',
//       date_from:  'YYYY-MM-DD',
//       date_to:    'YYYY-MM-DD',
//
//       // Enum multi-selects — only the values applicable to `kind` are honored.
//       state:    ['Current','Won','Lost', ...],   // lead/quote/job
//       category: ['3 Opportunity', ...],          // lead
//       type:     ['NEW EQUIPMENT', ...],          // job/quote
//
//       // Relation-name substring matches — useful since WFM has no
//       // native filter-by-FK on the list endpoints. We just match on
//       // the embedded Client.Name / Contact.Name / Owner.Name /
//       // Manager.Name strings already in the record envelope.
//       client_name:   'rovop',
//       contact_name:  'doug',
//       owner_name:    'wes',
//       manager_name:  'falynne',
//
//       // Numeric range — kind-specific amount_field
//       // (see AMOUNT_FIELDS_BY_KIND).
//       amount_field: 'AmountIncludingTax'|'Amount'|'EstimatedCost'|
//                     'EstimatedValue',
//       amount_min:   100000,
//       amount_max:   500000,
//
//       // Boolean flags (clients only).
//       is_archived:  true|false,
//       is_prospect:  true|false,
//     },
//     limit: 100,   // 1..500, default 50
//   }
//
// Returns up to `limit` matches, in the same { samples: { plural: [] } }
// shape as /sample so the page populates with the existing card UI.
//
// Strategy per kind:
//   client → /client.api/search (native) when only query+no filters,
//            else /client.api/list paginated walk + filter
//   lead   → /lead.api/current (single shot, big page) + filter
//   quote  → /quote.api/current (single shot) + filter
//   job    → /job.api/current   (single shot) + filter
//   staff  → /staff.api/list    (small, ~30) + filter

import { hasRole } from '../../lib/auth.js';
import { apiGet, recordList } from '../../lib/wfm-client.js';

const DEFAULT_LIMIT  = 50;
const MAX_LIMIT      = 500;
const MAX_LIST_PAGES = 8;          // cap the list-walk for paginated kinds
const LIST_PAGE_SIZE = 100;
const SINGLE_SHOT_PAGE_SIZE = 500; // for /current endpoints

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

// Per-kind list of date fields we know how to filter on. Order
// matches the UI dropdown. The UI is allowed to send any field, but
// if it's not in the WFM record we simply skip the row.
const DATE_FIELDS_BY_KIND = {
  lead:  ['Date', 'DateWonLost'],
  quote: ['Date', 'ValidDate'],
  job:   ['StartDate', 'DueDate', 'DateCreatedUtc', 'DateModifiedUtc'],
  client: [],
  staff:  [],
};

const AMOUNT_FIELDS_BY_KIND = {
  lead:  ['EstimatedValue'],
  quote: ['AmountIncludingTax', 'Amount', 'EstimatedCost'],
  job:   ['Budget'],
  client: [],
  staff:  [],
};

// ---------- helpers ----------

function lc(v) {
  return String(v ?? '').toLowerCase();
}

function recordHasText(rec, qLower) {
  if (!qLower) return true;
  const fields = [
    rec.Name, rec.ID, rec.UUID, rec.Description, rec.Email, rec.Phone,
    rec.Client?.Name, rec.Contact?.Name, rec.Owner?.Name, rec.Manager?.Name,
  ];
  for (const f of fields) {
    if (f && lc(f).includes(qLower)) return true;
  }
  return false;
}

// Pull a date string from a WFM record at the given key, return as
// 'YYYY-MM-DD' (or null if missing/unparseable). WFM uses
// 'YYYY-MM-DDTHH:mm:ss' (no TZ) on most fields; we just take the
// first 10 chars after a basic shape check.
function recordDate(rec, field) {
  const v = rec?.[field];
  if (!v || typeof v !== 'string') return null;
  const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function recordAmount(rec, field) {
  const raw = rec?.[field];
  if (raw === undefined || raw === null || raw === '') return null;
  const n = parseFloat(String(raw).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function bool(v) {
  if (v === true || v === 'true' || v === 'Yes' || v === 'yes' || v === 1) return true;
  if (v === false || v === 'false' || v === 'No' || v === 'no' || v === 0) return false;
  return null;
}

// Decide whether a single record passes the filter set. Filters that
// don't apply to this kind are simply not consulted (the caller is
// expected to scrub them — but we re-check defensively).
function recordMatches(rec, kind, query, filters) {
  if (!recordHasText(rec, lc(query))) return false;

  const f = filters || {};

  // Date range
  if (f.date_field && (f.date_from || f.date_to)) {
    if (!(DATE_FIELDS_BY_KIND[kind] || []).includes(f.date_field)) {
      // Field doesn't apply to this kind — ignore the filter rather
      // than rejecting every record.
    } else {
      const recd = recordDate(rec, f.date_field);
      if (!recd) return false;            // record has no date in this field → exclude
      if (f.date_from && recd < f.date_from) return false;
      if (f.date_to   && recd > f.date_to)   return false;
    }
  }

  // Enum multi-selects
  if (Array.isArray(f.state) && f.state.length > 0) {
    if (!f.state.includes(rec.State)) return false;
  }
  if (Array.isArray(f.category) && f.category.length > 0) {
    if (!f.category.includes(rec.Category)) return false;
  }
  if (Array.isArray(f.type) && f.type.length > 0) {
    if (!f.type.includes(rec.Type)) return false;
  }

  // Relation-name substrings
  if (f.client_name  && !lc(rec.Client?.Name  ).includes(lc(f.client_name )))  return false;
  if (f.contact_name && !lc(rec.Contact?.Name ).includes(lc(f.contact_name))) return false;
  if (f.owner_name   && !lc(rec.Owner?.Name   ).includes(lc(f.owner_name  ))) return false;
  if (f.manager_name && !lc(rec.Manager?.Name ).includes(lc(f.manager_name))) return false;

  // Amount range
  if (f.amount_field && (f.amount_min !== undefined || f.amount_max !== undefined)) {
    if ((AMOUNT_FIELDS_BY_KIND[kind] || []).includes(f.amount_field)) {
      const amt = recordAmount(rec, f.amount_field);
      if (amt === null) return false;
      if (f.amount_min !== undefined && f.amount_min !== null && f.amount_min !== '' && amt < Number(f.amount_min)) return false;
      if (f.amount_max !== undefined && f.amount_max !== null && f.amount_max !== '' && amt > Number(f.amount_max)) return false;
    }
  }

  // Boolean (clients only)
  if (kind === 'client') {
    if (f.is_archived !== undefined) {
      const want = bool(f.is_archived);
      if (want !== null && bool(rec.IsArchived) !== want) return false;
    }
    if (f.is_prospect !== undefined) {
      const want = bool(f.is_prospect);
      if (want !== null && bool(rec.IsProspect) !== want) return false;
    }
  }

  return true;
}

// ---------- fetchers ----------

async function searchClientsNative(env, query) {
  const r = await apiGet(env, '/client.api/search?query=' + encodeURIComponent(query));
  if (!r.ok) throw new Error('client search failed: ' + r.status);
  return recordList(r.body, 'Client');
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

async function fetchAllRecords(env, basePath, primaryKey) {
  // Probe pagination support. /current endpoints return everything in
  // one shot and ignore page= params; /list paginates with TotalRecords.
  const total = await readTotalRecords(env, basePath);

  if (total === null) {
    // Single-shot endpoint.
    const sep = basePath.includes('?') ? '&' : '?';
    const r = await apiGet(env, basePath + sep + 'pageSize=' + SINGLE_SHOT_PAGE_SIZE);
    if (!r.ok) return [];
    return recordList(r.body, primaryKey);
  }

  const all = [];
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
      all.push(rec);
    }
    if (arr.length < LIST_PAGE_SIZE) break;
  }
  return all;
}

// ---------- handler ----------

function hasAnyFilter(filters) {
  if (!filters) return false;
  const keys = [
    'date_field','date_from','date_to',
    'state','category','type',
    'client_name','contact_name','owner_name','manager_name',
    'amount_field','amount_min','amount_max',
    'is_archived','is_prospect',
  ];
  for (const k of keys) {
    const v = filters[k];
    if (Array.isArray(v) ? v.length > 0 : (v !== undefined && v !== null && v !== '')) {
      return true;
    }
  }
  return false;
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
  const filters = body.filters && typeof body.filters === 'object' ? body.filters : {};
  const requestedLimit = parseInt(body.limit, 10);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, MAX_LIMIT)
    : DEFAULT_LIMIT;

  const cfg = KIND_CONFIG[kind];
  if (!cfg) return json({ ok: false, error: 'bad_kind', allowed: Object.keys(KIND_CONFIG) }, 400);

  const anyFilter = hasAnyFilter(filters);
  if (!query && !anyFilter) {
    return json({ ok: false, error: 'query_or_filter_required' }, 400);
  }

  try {
    let results = [];
    const qLower = lc(query);

    if (kind === 'client') {
      // Native search is fastest, but only the text shape; if any
      // structured filters are set we walk /list to apply them.
      if (query && !anyFilter) {
        try { results = await searchClientsNative(env, query); }
        catch (_) { /* fall through */ }
      }
      if (results.length === 0) {
        const all = await fetchAllRecords(env, '/client.api/list', 'Client');
        results = all.filter((rec) => recordMatches(rec, kind, query, filters));
      }
    } else if (kind === 'staff') {
      const r = await apiGet(env, '/staff.api/list');
      if (!r.ok) throw new Error('staff list failed: ' + r.status);
      const all = recordList(r.body, 'Staff');
      results = all.filter((rec) => recordMatches(rec, kind, query, filters));
    } else {
      // lead / quote / job — walk /current
      const basePath = '/' + kind + '.api/current';
      const all = await fetchAllRecords(env, basePath, cfg.primary);
      results = all.filter((rec) => recordMatches(rec, kind, query, filters));
    }

    const truncated = results.length > limit;
    if (truncated) results = results.slice(0, limit);

    return json({
      ok: true,
      kind,
      query,
      filters,
      samples: { [cfg.plural]: results },
      count: results.length,
      truncated,
    });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, 500);
  }
}
