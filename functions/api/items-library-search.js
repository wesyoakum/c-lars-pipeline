// functions/api/items-library-search.js
//
// GET /api/items-library-search?q=<term>&type=<item_type>&limit=20
//
// Returns JSON array of matching library items for typeahead.

import { all } from '../lib/db.js';

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  const type = url.searchParams.get('type') || '';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 50);

  if (!q || q.length < 2) {
    return json([]);
  }

  const like = `%${q}%`;
  let typeFilter = '';
  const params = [like, like, like, like, like, like];
  if (type) {
    typeFilter = ' AND item_type = ?';
    params.push(type);
  }
  params.push(q);   // for exact part_number match sort
  params.push(limit);

  const rows = await all(env.DB,
    `SELECT id, name, part_number, description, item_type,
            default_unit, default_price, default_cost,
            use_count, last_used_at, item_notes, category
       FROM items_library
      WHERE deleted_at IS NULL AND active = 1
        AND (name LIKE ? OR part_number LIKE ? OR description LIKE ?
             OR category LIKE ? OR item_notes LIKE ? OR default_unit LIKE ?)
        ${typeFilter}
      ORDER BY
        CASE WHEN part_number = ? THEN 0 ELSE 1 END,
        use_count DESC,
        last_used_at DESC
      LIMIT ?`,
    params);

  return json(rows);
}

function json(data) {
  return new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
