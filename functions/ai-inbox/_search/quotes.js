// functions/ai-inbox/_search/quotes.js
//
// GET /ai-inbox/_search/quotes?q=&account_id=&opportunity_id=&closed=&limit=
//
// Typeahead endpoint for the link_to_quote inline form. Mirrors the
// rank-based pattern used by accounts / contacts / opportunities.
// Optional `account_id` and `opportunity_id` scope the results so the
// picker can be narrowed to the entry's resolved org / opp when one
// exists.
//
// By default closed quotes (status IN closed states) are filtered
// out. Pass `closed=1` to include them — useful for retroactively
// linking an entry to a quote that already shipped.
//
// Response:
//   { results: [{ ref_type:'quote', ref_id, label, sub }, ...] }

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

const ACTIVE_QUOTE_STATUSES = "('draft','issued','revision_draft','revision_issued','accepted')";

export async function onRequestGet(context) {
  const { env, request, data } = context;
  const user = data?.user;
  if (!user || !user.id) return json({ results: [] }, 401);

  const url = new URL(request.url);
  const qRaw = (url.searchParams.get('q') || '').trim();
  const limit = Math.max(1, Math.min(20, Number(url.searchParams.get('limit')) || 10));
  const accountId = (url.searchParams.get('account_id') || '').trim();
  const opportunityId = (url.searchParams.get('opportunity_id') || '').trim();
  const includeClosed = url.searchParams.get('closed') === '1';
  const q = qRaw.toLowerCase();
  const like = q ? `%${q}%` : null;

  const conds = [];
  const params = [];
  if (!includeClosed) conds.push(`q.status IN ${ACTIVE_QUOTE_STATUSES}`);
  if (opportunityId) {
    conds.push('q.opportunity_id = ?');
    params.push(opportunityId);
  }
  if (accountId) {
    conds.push('o.account_id = ?');
    params.push(accountId);
  }
  if (like) {
    conds.push('(LOWER(q.number) LIKE ? OR LOWER(COALESCE(q.title,\'\')) LIKE ?)');
    params.push(like, like);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  params.push(limit * 2);

  const sql = `
    SELECT q.id, q.number, q.title, q.status, q.opportunity_id,
           o.number AS opp_number, o.title AS opp_title,
           o.account_id, a.name AS account_name, a.alias AS account_alias
      FROM quotes q
      LEFT JOIN opportunities o ON o.id = q.opportunity_id
      LEFT JOIN accounts a ON a.id = o.account_id
     ${where}
     ORDER BY q.updated_at DESC
     LIMIT ?
  `;

  const rows = await all(env.DB, sql, params);
  const showAlias = !!user?.show_alias;

  const scored = rows.map((r) => {
    const label = r.number || '(unnamed)';
    const accountPart = r.account_name
      ? (showAlias && r.account_alias ? r.account_alias : r.account_name)
      : '';
    const oppPart = r.opp_number ? `OPP-${r.opp_number}` : '';
    const sub = [r.title, oppPart, accountPart].filter(Boolean).join(' · ');
    const score = q ? Math.max(scoreMatch(label, q), scoreMatch(r.title || '', q)) : 0;
    return { ref_type: 'quote', ref_id: r.id, label, sub, _score: score };
  });

  if (q) scored.sort((a, b) => b._score - a._score);

  const results = scored.slice(0, limit).map(({ _score, ...rest }) => rest);
  return json({ results });
}
