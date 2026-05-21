// functions/settings/wfm-import/probe-list.js
//
// GET /settings/wfm-import/probe-list?kind=lead&page=1
//
// Diagnostic: hit /<kind>.api/list and dump the raw parsed response
// so we can see the XML structure and record keys.

import { hasRole } from '../../lib/auth.js';
import { apiGet } from '../../lib/wfm-client.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user || !hasRole(user, 'admin')) return json({ error: 'admin only' }, 403);

  const url = new URL(request.url);
  const kind = url.searchParams.get('kind') || 'lead';
  const page = url.searchParams.get('page') || '1';
  const pageSize = url.searchParams.get('pageSize') || '5';

  const path = `/${kind}.api/list?page=${page}&pageSize=${pageSize}`;
  const r = await apiGet(env, path);

  return json({
    path,
    status: r.status,
    ok: r.ok,
    bodyKeys: r.body ? Object.keys(r.body) : null,
    responseKeys: r.body?.Response ? Object.keys(r.body.Response) : null,
    totalRecords: r.body?.Response?.TotalRecords ?? null,
    firstRecordKeys: (() => {
      // Try to find any array of records in the response
      const resp = r.body?.Response;
      if (!resp) return null;
      for (const key of Object.keys(resp)) {
        const val = resp[key];
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          // Could be a wrapper like { Lead: [...] } or { Lead: { ... } }
          for (const subKey of Object.keys(val)) {
            const sub = val[subKey];
            if (Array.isArray(sub) && sub.length > 0) {
              return { wrapper: key, recordKey: subKey, count: sub.length, firstRecord: sub[0] };
            }
            if (sub && typeof sub === 'object' && sub.UUID) {
              return { wrapper: key, recordKey: subKey, count: 1, firstRecord: sub };
            }
          }
        }
        if (Array.isArray(val) && val.length > 0) {
          return { wrapper: null, recordKey: key, count: val.length, firstRecord: val[0] };
        }
      }
      return null;
    })(),
    rawBody: r.body,
  });
}
