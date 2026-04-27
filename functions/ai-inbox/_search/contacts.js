// functions/ai-inbox/_search/contacts.js
//
// GET /ai-inbox/_search/contacts?q=&account_id=&limit=
//
// Typeahead endpoint for contacts. Optional `account_id` scopes results
// to one account (used by create-contact when an org has already been
// resolved on this item).
//
// Response:
//   { results: [{ ref_type:'contact', ref_id, label, sub }, ...] }

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
  const accountId = (url.searchParams.get('account_id') || '').trim();
  const q = qRaw.toLowerCase();
  const like = q ? `%${q}%` : null;

  const params = [];
  let where = '';
  if (accountId) {
    where += ' WHERE c.account_id = ?';
    params.push(accountId);
  }
  if (like) {
    where += where ? ' AND' : ' WHERE';
    where += ` (LOWER(COALESCE(c.first_name,'')) LIKE ?
            OR LOWER(COALESCE(c.last_name,'')) LIKE ?
            OR LOWER(COALESCE(c.email,'')) LIKE ?
            OR LOWER(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) LIKE ?)`;
    params.push(like, like, like, like);
  }
  params.push(limit * 2);

  const sql = `
    SELECT c.id, c.first_name, c.last_name, c.email, c.account_id,
           a.name AS account_name, a.alias AS account_alias
      FROM contacts c
      LEFT JOIN accounts a ON a.id = c.account_id
     ${where}
     ORDER BY COALESCE(c.last_name, c.first_name, '') COLLATE NOCASE,
              c.first_name COLLATE NOCASE
     LIMIT ?`;

  const rows = await all(env.DB, sql, params);

  const scored = rows.map(r => {
    const full = `${r.first_name || ''} ${r.last_name || ''}`.trim();
    const candidates = [full, r.email].filter(Boolean);
    const score = q ? Math.max(...candidates.map(c => scoreMatch(c, q))) : 0;
    const orgName = (showAlias && r.account_alias) ? r.account_alias : (r.account_name || '');
    const sub = [orgName, r.email].filter(Boolean).join(' · ');
    return {
      ref_type: 'contact',
      ref_id: r.id,
      label: full || r.email || '(unnamed)',
      sub,
      _score: score,
    };
  });

  if (q) scored.sort((a, b) => b._score - a._score);

  const results = scored.slice(0, limit).map(({ _score, ...rest }) => rest);
  return json({ results });
}
