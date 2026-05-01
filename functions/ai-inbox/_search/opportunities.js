// functions/ai-inbox/_search/opportunities.js
//
// GET /ai-inbox/_search/opportunities?q=&account_id=&limit=
//
// Typeahead endpoint for the link_to_opportunity inline form. Mirrors
// the rank-based pattern used by accounts/contacts search. Optional
// `account_id` scopes results to opportunities at that account (handy
// when an entry has a resolved org and the user wants to link the
// entry to an opp at that org).
//
// By default only OPEN opportunities (anything not closed_*) are
// returned, ordered by most-recently-updated first. Pass `closed=1`
// to include closed ones too — useful for retroactively linking an
// entry to a deal that already wrapped.
//
// Response:
//   { results: [{ ref_type:'opportunity', ref_id, label, sub }, ...] }

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

const CLOSED_STAGES = "('won','lost','abandoned')";

export async function onRequestGet(context) {
  const { env, request, data } = context;
  const user = data?.user;
  if (!user || !user.id) return json({ results: [] }, 401);

  const url = new URL(request.url);
  const qRaw = (url.searchParams.get('q') || '').trim();
  const limit = Math.max(1, Math.min(20, Number(url.searchParams.get('limit')) || 10));
  const accountId = (url.searchParams.get('account_id') || '').trim();
  const includeClosed = url.searchParams.get('closed') === '1';
  const q = qRaw.toLowerCase();
  const like = q ? `%${q}%` : null;

  const conds = [];
  const params = [];
  if (!includeClosed) conds.push(`o.stage NOT IN ${CLOSED_STAGES}`);
  if (accountId) {
    conds.push('o.account_id = ?');
    params.push(accountId);
  }
  if (like) {
    conds.push('(LOWER(CAST(o.number AS TEXT)) LIKE ? OR LOWER(o.title) LIKE ?)');
    params.push(like, like);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  params.push(limit * 2);

  const sql = `
    SELECT o.id, o.number, o.title, o.transaction_type, o.stage,
           o.account_id, a.name AS account_name, a.alias AS account_alias
      FROM opportunities o
      LEFT JOIN accounts a ON a.id = o.account_id
     ${where}
     ORDER BY o.updated_at DESC
     LIMIT ?
  `;

  const rows = await all(env.DB, sql, params);
  const showAlias = !!user?.show_alias;

  const scored = rows.map((r) => {
    const numStr = r.number != null ? String(r.number) : '';
    const label = numStr ? `OPP-${numStr}` : (r.title || '(unnamed)');
    const accountPart = r.account_name
      ? (showAlias && r.account_alias ? r.account_alias : r.account_name)
      : '';
    const sub = [r.title, accountPart].filter(Boolean).join(' · ');
    const score = q ? Math.max(scoreMatch(label, q), scoreMatch(r.title || '', q)) : 0;
    return { ref_type: 'opportunity', ref_id: r.id, label, sub, _score: score };
  });

  if (q) scored.sort((a, b) => b._score - a._score);

  const results = scored.slice(0, limit).map(({ _score, ...rest }) => rest);
  return json({ results });
}
