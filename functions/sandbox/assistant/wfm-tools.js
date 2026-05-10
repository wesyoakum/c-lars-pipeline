// functions/sandbox/assistant/wfm-tools.js
//
// Live WFM (BlueRock WorkflowMax) lookup tools for Claudia. Read-only,
// no writes. Lets her answer "where does this stand in WFM?" by hitting
// BlueRock directly when Pipeline's synced copy is stale or missing.
//
// Reuses functions/lib/wfm-client.js for auth + transport (refresh
// token rotation, account_id header, XML→JSON parsing). The two tools
// here just decide which endpoint to call and what to chase.

import { apiGet, recordList } from '../../lib/wfm-client.js';

// Per-entity routing. Each row maps a logical type to the WFM paths +
// XML envelope keys we need.
//
// list:      path for fuzzy-search. ".api/current" returns active rows
//            (probe shows this is what list endpoints actually accept
//            for lead/quote/job/invoice — "/X.api/list" 400s on those).
// listKey:   singular tag inside response.{Plural}. The probe confirms
//            BlueRock's XML envelope is always Response → Plural →
//            Singular[].
// get:       path for the by-id fetch. WFM accepts both UUID and the
//            short ID (J25024, Q25008, INV-0003) for most types.
const ENTITY_CONFIG = {
  client: {
    list:    'client.api/list',
    listKey: 'Client',
    get:     (id) => `client.api/get/${encodeURIComponent(id)}`,
  },
  lead: {
    list:    'lead.api/current',
    listKey: 'Lead',
    get:     (id) => `lead.api/get/${encodeURIComponent(id)}`,
  },
  quote: {
    list:    'quote.api/current',
    listKey: 'Quote',
    get:     (id) => `quote.api/get/${encodeURIComponent(id)}`,
  },
  job: {
    list:    'job.api/current',
    listKey: 'Job',
    get:     (id) => `job.api/get/${encodeURIComponent(id)}`,
  },
  invoice: {
    list:    'invoice.api/current',
    listKey: 'Invoice',
    get:     (id) => `invoice.api/get/${encodeURIComponent(id)}`,
  },
};

const VALID_TYPES = Object.keys(ENTITY_CONFIG);

// Pull response.{Singular} out of a parsed get-response. Lists go
// through recordList() in wfm-client.js; gets land here.
function extractSingleRecord(body, singularKey) {
  if (!body || typeof body !== 'object') return null;
  const r = body.Response;
  if (!r || typeof r !== 'object') return null;
  if (r[singularKey] && typeof r[singularKey] === 'object') return r[singularKey];
  return null;
}

// Compact summary for search hits — keeps the tool response small
// enough that a 50-row match list doesn't blow the model's context.
function summarizeRecord(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const uuid  = rec.UUID || '';
  const id    = rec.ID || '';
  const name  = rec.Name || rec.Description || '';
  const state = rec.State || rec.Status || '';
  const client = rec.Client && rec.Client.Name ? rec.Client.Name : undefined;
  const out = { uuid, id, name, state };
  if (client) out.client = client;
  return out;
}

// Translate the typed errors wfm-client throws into tool-shaped
// responses Claudia can read and surface to the user.
function asToolError(err) {
  if (err?.code === 'reconnect_required') {
    return {
      error: 'wfm_not_connected',
      message: 'WFM refresh token is dead — reconnect at /settings/wfm-import → Reconnect.',
    };
  }
  if (err?.code === 'no_refresh_token' || err?.code === 'no_oauth_app') {
    return {
      error: 'wfm_not_configured',
      message: err.message,
    };
  }
  return {
    error: 'wfm_failed',
    message: String(err?.message || err),
  };
}

// ---------------------------------------------------------------------
// wfm_search — fuzzy match by name or short ID, OR list-mode if query
// is omitted (returns first N records as a "what's in WFM" peek).
// ---------------------------------------------------------------------

export async function wfmSearch(env, input) {
  const type  = String(input?.type || '').toLowerCase();
  const query = String(input?.query || '').trim();
  const limit = Math.max(1, Math.min(50, Number(input?.limit) || 20));

  if (!VALID_TYPES.includes(type)) {
    return { error: 'invalid_type', message: `type must be one of: ${VALID_TYPES.join(', ')}` };
  }

  const cfg = ENTITY_CONFIG[type];
  let res;
  try {
    res = await apiGet(env, cfg.list);
  } catch (err) {
    return asToolError(err);
  }
  if (!res.ok) {
    return {
      error: 'wfm_request_failed',
      status: res.status,
      message: typeof res.rawText === 'string' ? res.rawText.slice(0, 300) : '',
    };
  }

  const records = recordList(res.body, cfg.listKey);
  const q = query.toLowerCase();
  const matches = [];
  for (const rec of records) {
    const summary = summarizeRecord(rec);
    if (!summary) continue;
    if (q) {
      // Filter mode: substring against a few searchable fields.
      const haystack = `${summary.name} ${summary.id} ${summary.client || ''}`.toLowerCase();
      if (!haystack.includes(q)) continue;
    }
    // No-query mode: just return first N as-is.
    matches.push(summary);
    if (matches.length >= limit) break;
  }

  return {
    type,
    query: q || null,
    matches,
    matched_count: matches.length,
    total_records_searched: records.length,
    mode: q ? 'filtered' : 'list',
  };
}

// ---------------------------------------------------------------------
// wfm_count — totals per kind, lightweight health-check probe.
// ---------------------------------------------------------------------
//
// Strategy: try Response.TotalRecords from a page=1&pageSize=1 fetch
// (paginated endpoints expose it). When it isn't present (the
// /current endpoints are single-shot and don't carry the field),
// fall back to fetching the full list and using its length. Total
// wall-clock for the cheap path: ~1–2s; full-fallback path: same as
// a list refresh.

const COUNT_KINDS = [
  { kind: 'client',  list: 'client.api/list',     listKey: 'Client' },
  { kind: 'lead',    list: 'lead.api/current',    listKey: 'Lead' },
  { kind: 'quote',   list: 'quote.api/current',   listKey: 'Quote' },
  { kind: 'job',     list: 'job.api/current',     listKey: 'Job' },
  { kind: 'invoice', list: 'invoice.api/current', listKey: 'Invoice' },
  { kind: 'staff',   list: 'staff.api/list',      listKey: 'Staff' },
];

async function wfmTotalRecordsHint(env, basePath) {
  const sep = basePath.includes('?') ? '&' : '?';
  const r = await apiGet(env, basePath + sep + 'page=1&pageSize=1');
  if (!r.ok) return { ok: false, status: r.status };
  const totalStr = r.body?.Response?.TotalRecords;
  if (totalStr == null) return { ok: true, count: null }; // signal: needs full fetch
  const n = parseInt(totalStr, 10);
  return { ok: true, count: Number.isNaN(n) ? null : n };
}

async function countOneKind(env, cfg) {
  try {
    const hint = await wfmTotalRecordsHint(env, cfg.list);
    if (!hint.ok) {
      return { count: null, error: `http_${hint.status}` };
    }
    if (hint.count != null) {
      return { count: hint.count, source: 'total_records' };
    }
    // Fallback: pull the full list, count locally.
    const r = await apiGet(env, cfg.list);
    if (!r.ok) {
      return { count: null, error: `http_${r.status}` };
    }
    const records = recordList(r.body, cfg.listKey);
    return { count: records.length, source: 'full_list' };
  } catch (err) {
    if (err?.code === 'reconnect_required')   return { count: null, error: 'wfm_not_connected' };
    if (err?.code === 'no_refresh_token')     return { count: null, error: 'wfm_not_configured' };
    if (err?.code === 'no_oauth_app')         return { count: null, error: 'wfm_not_configured' };
    return { count: null, error: err?.message || String(err) };
  }
}

export async function wfmCount(env) {
  const start = Date.now();
  const results = await Promise.all(COUNT_KINDS.map(async (cfg) => {
    const r = await countOneKind(env, cfg);
    return { kind: cfg.kind, ...r };
  }));
  const counts = {};
  const errors = {};
  for (const r of results) {
    counts[r.kind] = r.count;
    if (r.error) errors[r.kind] = r.error;
  }
  return {
    counts,
    errors: Object.keys(errors).length > 0 ? errors : undefined,
    fetched_at: new Date().toISOString(),
    duration_ms: Date.now() - start,
  };
}

// ---------------------------------------------------------------------
// wfm_get — fetch a record + first-level relations
// ---------------------------------------------------------------------

export async function wfmGet(env, input) {
  const type = String(input?.type || '').toLowerCase();
  const id   = String(input?.id || '').trim();

  if (!VALID_TYPES.includes(type)) {
    return { error: 'invalid_type', message: `type must be one of: ${VALID_TYPES.join(', ')}` };
  }
  if (!id) {
    return { error: 'invalid_id', message: 'id is required (UUID or short ID like J25024)' };
  }

  const cfg = ENTITY_CONFIG[type];
  let res;
  try {
    res = await apiGet(env, cfg.get(id));
  } catch (err) {
    return asToolError(err);
  }
  if (!res.ok) {
    return {
      error: 'wfm_not_found',
      status: res.status,
      message: (typeof res.rawText === 'string' ? res.rawText.slice(0, 300) : '') || `${type} ${id} not found in WFM`,
    };
  }

  const record = extractSingleRecord(res.body, cfg.listKey);
  if (!record) {
    return {
      error: 'wfm_unparseable',
      message: 'WFM response did not contain the expected record envelope.',
      raw: typeof res.rawText === 'string' ? res.rawText.slice(0, 1000) : null,
    };
  }

  // First-level relation chase along the lead → quote → job → invoice
  // chain. Each branch makes at most one extra apiGet.
  // Best-effort: if a relation lookup fails, attach _note and return
  // the primary record anyway.
  const related = {};
  try {
    if (type === 'quote' && record.JobUUID) {
      const j = await apiGet(env, ENTITY_CONFIG.job.get(record.JobUUID));
      if (j.ok) related.job = extractSingleRecord(j.body, 'Job');
    } else if (type === 'job' && record.ApprovedQuoteUUID) {
      const q = await apiGet(env, ENTITY_CONFIG.quote.get(record.ApprovedQuoteUUID));
      if (q.ok) related.approved_quote = extractSingleRecord(q.body, 'Quote');
    } else if (type === 'invoice' && record.JobUUID) {
      const j = await apiGet(env, ENTITY_CONFIG.job.get(record.JobUUID));
      if (j.ok) related.job = extractSingleRecord(j.body, 'Job');
    } else if (type === 'lead' && record.UUID) {
      // No direct lead → quote endpoint exists; scan current quotes for
      // a matching LeadUUID. Bounded by quote.api/current's response size.
      const ql = await apiGet(env, ENTITY_CONFIG.quote.list);
      if (ql.ok) {
        const quotes = recordList(ql.body, 'Quote');
        const found = quotes.find((q) => q && q.LeadUUID === record.UUID);
        if (found) related.quote = found;
      }
    }
    // Client returns include nested Contacts already; nothing extra to chase.
  } catch (err) {
    related._note = `relation lookup failed: ${err?.message || String(err)}`;
  }

  return {
    type,
    record,
    related: Object.keys(related).length > 0 ? related : undefined,
  };
}
