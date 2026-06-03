// functions/api/katana-suppliers.js
//
// GET  /api/katana-suppliers          — list all Katana suppliers (for typeahead)
// POST /api/katana-suppliers/create   — create a new supplier in Katana

import { apiGetAll, apiPost } from '../lib/katana-client.js';

export async function onRequestGet(context) {
  const { env } = context;
  try {
    const suppliers = await apiGetAll(env, '/suppliers');
    return json({ ok: true, suppliers });
  } catch (e) {
    return json({ ok: false, error: String(e.message ?? e) }, 500);
  }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }

  const name = (body.name || '').trim();
  if (!name) return json({ ok: false, error: 'Supplier name is required' }, 400);

  try {
    const result = await apiPost(env, '/suppliers', { name });
    const supplier = result?.data || result;
    return json({ ok: true, supplier });
  } catch (e) {
    return json({ ok: false, error: String(e.message ?? e) }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
