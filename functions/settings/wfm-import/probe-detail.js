// functions/settings/wfm-import/probe-detail.js
//
// GET /settings/wfm-import/probe-detail?kind=quote
//
// One-shot diagnostic probe: pick the first record from
// /quote.api/current (or /lead.api/current, /job.api/current), then
// fetch its detail at /<kind>.api/get/<UUID> and return the parsed
// response so we can eyeball which fields the detail endpoint exposes
// that aren't on the list endpoint.
//
// Specifically motivated by: do quotes have DateCreatedUtc /
// DateModifiedUtc on the detail response (like Jobs do) even though
// those fields don't appear on /quote.api/current?
//
// Admin-only. Returns JSON so you can read it raw in a browser tab.

import { hasRole } from '../../lib/auth.js';
import { apiGet, recordList } from '../../lib/wfm-client.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

const SUPPORTED = {
  quote: { listPath: '/quote.api/current', getPath: '/quote.api/get', primary: 'Quote' },
  lead:  { listPath: '/lead.api/current',  getPath: '/lead.api/get',  primary: 'Lead' },
  job:   { listPath: '/job.api/current',   getPath: '/job.api/get',   primary: 'Job' },
  client:{ listPath: '/client.api/list',   getPath: '/client.api/get',primary: 'Client' },
};

// Walk an object and emit one entry per leaf, with a dotted path. Used
// to surface every field the detail response carries — including
// nested ones — so we can spot date fields anywhere in the shape.
function flattenLeaves(obj, prefix = '', out = []) {
  if (obj === null || obj === undefined) {
    out.push({ path: prefix, value: obj });
    return out;
  }
  if (typeof obj !== 'object') {
    const s = String(obj);
    out.push({ path: prefix, value: s.length > 200 ? s.slice(0, 200) + '…' : s });
    return out;
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) {
      out.push({ path: prefix + '[]', value: '(empty array)' });
    } else {
      // Flatten only the first element so the output stays manageable;
      // also note the array length.
      out.push({ path: prefix + '.length', value: obj.length });
      flattenLeaves(obj[0], prefix + '[0]', out);
    }
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    flattenLeaves(v, prefix ? prefix + '.' + k : k, out);
  }
  return out;
}

export async function onRequestGet(context) {
  const { env, request, data } = context;
  const user = data?.user;
  if (!user) return json({ ok: false, error: 'sign_in_required' }, 401);
  if (!hasRole(user, 'admin')) return json({ ok: false, error: 'admin_only' }, 403);

  const url = new URL(request.url);
  const kind = String(url.searchParams.get('kind') || 'quote').toLowerCase();
  const uuidParam = String(url.searchParams.get('uuid') || '').trim();

  const cfg = SUPPORTED[kind];
  if (!cfg) return json({ ok: false, error: 'bad_kind', allowed: Object.keys(SUPPORTED) }, 400);

  try {
    let uuid = uuidParam;
    let listSampleKeys = null;

    if (!uuid) {
      // Pick the first record from the list endpoint to get a UUID.
      const listResp = await apiGet(env, cfg.listPath + '?page=1&pageSize=1');
      if (!listResp.ok) {
        return json({ ok: false, error: 'list_call_failed', status: listResp.status, raw: listResp.rawText.slice(0, 1000) }, 502);
      }
      const arr = recordList(listResp.body, cfg.primary);
      if (!arr.length) {
        return json({ ok: false, error: 'no_records', list_path: cfg.listPath });
      }
      uuid = arr[0].UUID || arr[0].ID;
      listSampleKeys = Object.keys(arr[0]).sort();
    }

    if (!uuid) return json({ ok: false, error: 'no_uuid_resolved' }, 500);

    const detailResp = await apiGet(env, cfg.getPath + '/' + encodeURIComponent(uuid));
    if (!detailResp.ok) {
      return json({
        ok: false,
        error: 'detail_call_failed',
        status: detailResp.status,
        raw: detailResp.rawText.slice(0, 1000),
        uuid,
      }, 502);
    }

    const arr = recordList(detailResp.body, cfg.primary);
    const detail = arr[0] || null;

    // Surface keys + leaves so the user can scan the shape.
    const detailKeys = detail ? Object.keys(detail).sort() : [];
    const detailLeaves = detail ? flattenLeaves(detail) : [];

    // Filter leaves whose path or value looks date-shaped.
    const dateLikeLeaves = detailLeaves.filter((l) => {
      const p = String(l.path).toLowerCase();
      const v = String(l.value || '');
      return /date|time|due|valid|created|modified/i.test(p) || /^\d{4}-\d{2}-\d{2}/.test(v);
    });

    return json({
      ok: true,
      kind,
      uuid,
      list_path: cfg.listPath,
      get_path: cfg.getPath + '/' + uuid,
      list_sample_keys: listSampleKeys,
      detail_top_level_keys: detailKeys,
      date_like_leaves: dateLikeLeaves,
      // Full detail body for reference. Big, but useful.
      detail_full: detail,
    });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) }, 500);
  }
}
