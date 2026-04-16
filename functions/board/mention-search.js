// functions/board/mention-search.js
//
// GET /board/mention-search?q=<text>&limit=<n>
//
// Unified autocomplete for the card body's @-picker. Returns a mixed
// list of users + opportunities + quotes + accounts + documents whose
// display label matches the query, ranked by match quality.
//
// Response shape:
//   { results: [
//       { ref_type: 'user',        ref_id, label, sub },
//       { ref_type: 'opportunity', ref_id, label, sub },
//       ...
//     ]
//   }
//
// The client inserts the pick into the body as:
//   @[<ref_type>:<ref_id>|<label>]

import { all } from '../lib/db.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export async function onRequestGet(context) {
  const { env, request, data } = context;
  const user = data?.user;
  if (!user || !user.id) return json({ results: [] }, 401);

  const url = new URL(request.url);
  const qRaw = (url.searchParams.get('q') || '').trim();
  const limit = Math.max(1, Math.min(20, Number(url.searchParams.get('limit')) || 8));

  // Empty query: return a short default mix (active users, most recent
  // opps) so the picker has something to show on first open.
  const q = qRaw.toLowerCase();
  const like = q ? `%${q}%` : null;

  const [users, opps, quotes, accounts, docs] = await Promise.all([
    like
      ? all(env.DB,
          `SELECT id, display_name, email FROM users
            WHERE active = 1
              AND (LOWER(display_name) LIKE ? OR LOWER(email) LIKE ?)
            ORDER BY display_name
            LIMIT ?`,
          [like, like, limit])
      : all(env.DB,
          `SELECT id, display_name, email FROM users
            WHERE active = 1 ORDER BY display_name LIMIT ?`,
          [limit]),

    like
      ? all(env.DB,
          `SELECT id, number, title FROM opportunities
            WHERE stage NOT IN ('closed_won','closed_lost','closed_abandoned')
              AND (LOWER(CAST(number AS TEXT)) LIKE ? OR LOWER(title) LIKE ?)
            ORDER BY updated_at DESC LIMIT ?`,
          [like, like, limit])
      : all(env.DB,
          `SELECT id, number, title FROM opportunities
            WHERE stage NOT IN ('closed_won','closed_lost','closed_abandoned')
            ORDER BY updated_at DESC LIMIT ?`,
          [limit]),

    like
      ? all(env.DB,
          `SELECT id, number, title FROM quotes
            WHERE status IN ('draft','issued','revision_draft','revision_issued','accepted')
              AND (LOWER(number) LIKE ? OR LOWER(title) LIKE ?)
            ORDER BY updated_at DESC LIMIT ?`,
          [like, like, limit])
      : all(env.DB,
          `SELECT id, number, title FROM quotes
            WHERE status IN ('draft','issued','revision_draft','revision_issued','accepted')
            ORDER BY updated_at DESC LIMIT ?`,
          [limit]),

    like
      ? all(env.DB,
          `SELECT id, name, alias FROM accounts
            WHERE LOWER(name) LIKE ? OR LOWER(COALESCE(alias,'')) LIKE ?
            ORDER BY name LIMIT ?`,
          [like, like, limit])
      : all(env.DB,
          `SELECT id, name, alias FROM accounts ORDER BY name LIMIT ?`,
          [limit]),

    like
      ? all(env.DB,
          `SELECT id, title, kind FROM documents
            WHERE LOWER(title) LIKE ?
            ORDER BY uploaded_at DESC LIMIT ?`,
          [like, limit])
      : all(env.DB,
          `SELECT id, title, kind FROM documents
            ORDER BY uploaded_at DESC LIMIT ?`,
          [limit]),
  ]);

  const results = [];
  for (const u of users) {
    results.push({
      ref_type: 'user',
      ref_id: u.id,
      label: u.display_name || u.email,
      sub: u.email || '',
    });
  }
  for (const o of opps) {
    results.push({
      ref_type: 'opportunity',
      ref_id: o.id,
      label: `OPP-${o.number}`,
      sub: o.title || '',
    });
  }
  for (const q2 of quotes) {
    results.push({
      ref_type: 'quote',
      ref_id: q2.id,
      label: q2.number || 'Quote',
      sub: q2.title || '',
    });
  }
  for (const a of accounts) {
    results.push({
      ref_type: 'account',
      ref_id: a.id,
      label: a.name,
      sub: a.alias || '',
    });
  }
  for (const d of docs) {
    results.push({
      ref_type: 'document',
      ref_id: d.id,
      label: d.title,
      sub: d.kind || '',
    });
  }

  // Rank: exact prefix match first, then substring, then everything else.
  if (q) {
    results.sort((a, b) => scoreMatch(b.label, q) - scoreMatch(a.label, q));
  }

  return json({ results: results.slice(0, limit * 2) });
}

function scoreMatch(label, q) {
  const s = (label || '').toLowerCase();
  if (s === q) return 100;
  if (s.indexOf(q) === 0) return 80;
  if (s.indexOf(q) >= 0) return 40;
  return 0;
}
