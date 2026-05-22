// functions/api/katana-sync.js
//
// POST /api/katana-sync — sync Katana products + services into items_library.
// Also exported as syncKatana() for background use via waitUntil().
//
// Full replace: DELETEs all source='katana' rows, then INSERTs fresh ones.
// Small dataset (~30 products + ~10 services), completes in ~1-2s.

import { apiGetAll, listRecords } from '../lib/katana-client.js';
import { all, stmt, batch } from '../lib/db.js';
import { uuid, now } from '../lib/ids.js';
import { hasRole } from '../lib/auth.js';

/**
 * Sync all Katana products + services into items_library.
 * Safe to call frequently — idempotent full-replace.
 * Silently no-ops if KATANA_API_KEY is not set.
 */
export async function syncKatana(env) {
  if (!env.KATANA_API_KEY) return { ok: false, reason: 'no_api_key' };

  let products, services;
  try {
    [products, services] = await Promise.all([
      apiGetAll(env, '/products'),
      apiGetAll(env, '/services'),
    ]);
  } catch (e) {
    console.error('katana-sync: fetch failed', e.message);
    return { ok: false, reason: 'fetch_failed', error: e.message };
  }

  const ts = now();
  const statements = [];

  // Delete all existing katana rows
  statements.push(stmt(env.DB,
    `DELETE FROM items_library WHERE source = 'katana'`
  ));

  // Map products → items_library rows
  let productCount = 0;
  for (const p of products) {
    if (p.deleted_at) continue;
    const v = (p.variants || [])[0];
    const sku = v ? v.sku : null;
    const salesPrice = v ? v.sales_price : null;

    statements.push(stmt(env.DB,
      `INSERT INTO items_library (
         id, name, part_number, description, category, item_type,
         default_unit, default_price, source, item_notes,
         use_count, active, created_at, updated_at
       ) VALUES (?, ?, ?, NULL, ?, 'product', ?, ?, 'katana', ?, 0, 1, ?, ?)`,
      [
        uuid(),
        p.name || sku || 'Unknown',
        sku,
        p.category_name || null,
        p.uom || 'EA',
        salesPrice || null,
        p.additional_info || null,
        ts, ts,
      ]
    ));
    productCount++;
  }

  // Map services → items_library rows
  let serviceCount = 0;
  for (const s of services) {
    if (s.deleted_at) continue;
    const v = (s.variants || [])[0];
    const sku = v ? v.sku : null;
    const salesPrice = v ? v.sales_price : null;

    statements.push(stmt(env.DB,
      `INSERT INTO items_library (
         id, name, part_number, description, category, item_type,
         default_unit, default_price, source, item_notes,
         use_count, active, created_at, updated_at
       ) VALUES (?, ?, ?, NULL, ?, 'service', ?, ?, 'katana', ?, 0, 1, ?, ?)`,
      [
        uuid(),
        s.name || sku || 'Unknown',
        sku || null,
        s.category_name || null,
        s.uom || 'EA',
        salesPrice || null,
        s.additional_info || null,
        ts, ts,
      ]
    ));
    serviceCount++;
  }

  // Execute in batches of 50 (D1 limit)
  const CHUNK = 50;
  for (let i = 0; i < statements.length; i += CHUNK) {
    await batch(env.DB, statements.slice(i, i + CHUNK));
  }

  // Store last-synced timestamp
  try {
    await env.DB.prepare(
      `INSERT INTO site_prefs (key, value) VALUES ('katana_last_synced_at', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(ts).run();
  } catch { /* site_prefs may not have this key pattern — ignore */ }

  return { ok: true, products: productCount, services: serviceCount, synced_at: ts };
}

// POST handler for manual trigger
export async function onRequestPost(context) {
  const { env, data } = context;
  const user = data?.user;

  if (!hasRole(user, 'admin')) {
    return json({ ok: false, error: 'Admin role required.' }, 403);
  }

  const result = await syncKatana(env);
  return json(result, result.ok ? 200 : 500);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
