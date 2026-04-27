// functions/ai-inbox/_search/accounts.js
//
// GET /ai-inbox/_search/accounts?q=&limit=
//
// Typeahead endpoint scoped to AI Inbox so the route stays inside
// functions/ai-inbox/. Mirrors the rank-based pattern from
// functions/board/mention-search.js (exact 100, prefix 80, substring 40)
// against accounts.name / alias / parent_group.
//
// Empty query returns the most-recently-updated active accounts so the
// picker has something on first focus.
//
// Response:
//   { results: [{ ref_type:'account', ref_id, label, sub }, ...] }

import { all } from '../../lib/db.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function scoreMatch(label, q) {
  const s = (label || '').toLowerCase();
  if (s === q) return 100;
  if (s.indexOf(q) === 0) return 80;
  if (s.indexOf(q) >= 0) return 40;
  return 0;
}

export async function onRequestGet(context) {
  const { env, request, data } = context;
  const user = data?.user;
  if (!user || !user.id) return json({ results: [] }, 401);

  const showAlias = !!user?.show_alias;
  const url = new URL(request.url);
  const qRaw = (url.searchParams.get('q') || '').trim();
  const limit = Math.max(1, Math.min(20, Number(url.searchParams.get('limit')) || 10));
  const q = qRaw.toLowerCase();
  const like = q ? `%${q}%` : null;

  const rows = like
    ? await all(env.DB,
        `SELECT id, name, alias, parent_group
           FROM accounts
          WHERE is_active = 1
            AND (LOWER(name) LIKE ?
              OR LOWER(COALESCE(alias,'')) LIKE ?
              OR LOWER(COALESCE(parent_group,'')) LIKE ?)
          ORDER BY name LIMIT ?`,
        [like, like, like, limit * 2])
    : await all(env.DB,
        `SELECT id, name, alias, parent_group
           FROM accounts
          WHERE is_active = 1
          ORDER BY updated_at DESC LIMIT ?`,
        [limit]);

  const scored = rows.map(r => {
    const candidates = [r.name, r.alias, r.parent_group].filter(Boolean);
    const score = q ? Math.max(...candidates.map(c => scoreMatch(c, q))) : 0;
    const primary = showAlias ? (r.alias || r.name) : r.name;
    const secondary = showAlias
      ? (r.alias && r.alias !== r.name ? r.name : (r.parent_group || ''))
      : (r.alias && r.alias !== r.name ? r.alias : (r.parent_group || ''));
    return {
      ref_type: 'account',
      ref_id: r.id,
      label: primary,
      sub: secondary,
      _score: score,
    };
  });

  if (q) scored.sort((a, b) => b._score - a._score);

  const results = scored.slice(0, limit).map(({ _score, ...rest }) => rest);
  return json({ results });
}
