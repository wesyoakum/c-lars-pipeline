// functions/settings/mrpeasy-import/probe.js
//
// GET /settings/mrpeasy-import/probe
//
// Entity-discovery probe. MRPeasy's docs describe ~53 read streams but
// don't pin exact REST paths, and the surface varies by account/plan.
// This hits every candidate endpoint with limit=1 and reports HTTP
// status + the Content-Range total, so we discover the real surface
// for THIS account instead of guessing. The export job then walks
// only the endpoints the probe confirmed.
//
// STRICTLY SERIAL — MRPeasy 429s on concurrent requests. Each candidate
// is awaited in turn with a small inter-request gap.
//
// Admin-only. Returns JSON.

import { hasRole } from '../../lib/auth.js';
import { apiGet, getCredentials } from '../../lib/mrpeasy-client.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Candidate endpoints. Ordered roughly CRM-first, then archive. Path
// variants included where the convention is uncertain (hyphen vs
// underscore vs nesting) — the probe reports which resolve.
const CANDIDATES = [
  // CRM-relevant
  '/customers',
  '/customer-orders',
  '/customer_orders',
  '/quotations',
  '/rfq',
  '/vendors',
  '/vendor-orders',
  '/items',
  '/products',
  '/invoices',
  '/sales-invoices',
  '/credit-invoices',
  // Procurement
  '/purchase-orders',
  '/purchase_orders',
  '/bills',
  // Manufacturing
  '/manufacturing-orders',
  '/manufacturing_orders',
  '/bom',
  '/boms',
  '/routings',
  '/operations',
  '/workstations',
  '/workstation-types',
  // Inventory
  '/stock',
  '/stock-items',
  '/stock-lots',
  '/lot-locations',
  '/serial-numbers',
  '/units',
  '/sites',
  '/storages',
  // Logistics
  '/shipments',
  '/rma',
  '/returns',
  // Reference / admin
  '/currencies',
  '/taxes',
  '/users',
  '/users/actions/list',
  '/parameters',
  '/relations',
  '/activities',
];

export async function onRequestGet(context) {
  const { env, data } = context;
  const user = data?.user;
  if (!user) return json({ ok: false, error: 'sign_in_required' }, 401);
  if (!hasRole(user, 'admin')) return json({ ok: false, error: 'admin_only' }, 403);

  // Fail fast with a clear message if creds aren't set.
  try {
    await getCredentials(env);
  } catch (err) {
    return json({ ok: false, error: String(err.message || err), code: err.code }, 400);
  }

  const results = [];
  const accessible = [];

  for (const path of CANDIDATES) {
    try {
      const r = await apiGet(env, path, { limit: 1, offset: 0 });
      const entry = {
        path,
        status: r.status,
        ok: r.ok,
        total: r.total,
        sample_keys: (r.ok && Array.isArray(r.body) && r.body[0] && typeof r.body[0] === 'object')
          ? Object.keys(r.body[0]).sort()
          : null,
      };
      if (!r.ok) {
        entry.detail = typeof r.body === 'string'
          ? r.body.slice(0, 200)
          : (r.body && JSON.stringify(r.body).slice(0, 200));
      }
      results.push(entry);
      if (r.ok) accessible.push({ path, total: r.total });
    } catch (err) {
      results.push({ path, status: 0, ok: false, error: String(err.message || err) });
    }
    // Inter-request gap — MRPeasy is serial-only; don't hammer it.
    await sleep(350);
  }

  return json({
    ok: true,
    probed: CANDIDATES.length,
    accessible_count: accessible.length,
    accessible,                 // [{path,total}] — the export will use these
    results,                    // full per-candidate detail
  });
}
