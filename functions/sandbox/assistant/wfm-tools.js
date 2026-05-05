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
// wfm_search — fuzzy match by name or short ID
// ---------------------------------------------------------------------

export async function wfmSearch(env, input) {
  const type  = String(input?.type || '').toLowerCase();
  const query = String(input?.query || '').trim();
  const limit = Math.max(1, Math.min(50, Number(input?.limit) || 20));

  if (!VALID_TYPES.includes(type)) {
    return { error: 'invalid_type', message: `type must be one of: ${VALID_TYPES.join(', ')}` };
  }
  if (!query) {
    return { error: 'invalid_query', message: 'query is required (substring to match against record names / IDs)' };
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
    const haystack = `${summary.name} ${summary.id} ${summary.client || ''}`.toLowerCase();
    if (haystack.includes(q)) {
      matches.push(summary);
      if (matches.length >= limit) break;
    }
  }

  return {
    type,
    query,
    matches,
    matched_count: matches.length,
    total_records_searched: records.length,
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
