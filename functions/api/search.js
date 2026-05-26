// functions/api/search.js
//
// GET /api/search?q=<term> — universal search across accounts, contacts,
// opportunities, quotes, and quote line items.
//
// Returns JSON { ok, results: [ { type, id, title, subtitle, url } ] }
// capped at 25 results total (5 per entity type). The client renders
// these in a dropdown under the nav search input.

import { all } from '../lib/db.js';
import { audit } from '../lib/audit.js';

const LIMIT_PER_TYPE = 5;

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();

  if (!q || q.length < 2) {
    return json({ ok: true, results: [] });
  }

  const like = `%${q}%`;

  // Run all queries in parallel for speed.
  const [accounts, contacts, opps, quotes, lines] = await Promise.all([
    all(env.DB,
      `SELECT id, name, alias, segment
         FROM accounts
        WHERE deleted_at IS NULL AND (name LIKE ? OR alias LIKE ?)
        LIMIT ?`,
      [like, like, LIMIT_PER_TYPE]),

    all(env.DB,
      `SELECT c.id, c.first_name, c.last_name, c.email, c.title,
              a.name AS account_name, a.id AS account_id
         FROM contacts c
         LEFT JOIN accounts a ON a.id = c.account_id
        WHERE c.deleted_at IS NULL
          AND (c.first_name LIKE ? OR c.last_name LIKE ? OR c.email LIKE ?)
        LIMIT ?`,
      [like, like, like, LIMIT_PER_TYPE]),

    all(env.DB,
      `SELECT o.id, o.number, o.title, o.description,
              a.name AS account_name
         FROM opportunities o
         LEFT JOIN accounts a ON a.id = o.account_id
        WHERE o.deleted_at IS NULL
          AND (o.number LIKE ? OR o.title LIKE ? OR o.description LIKE ?)
        LIMIT ?`,
      [like, like, like, LIMIT_PER_TYPE]),

    all(env.DB,
      `SELECT q.id, q.number, q.title, q.revision,
              q.opportunity_id, o.number AS opp_number
         FROM quotes q
         LEFT JOIN opportunities o ON o.id = q.opportunity_id
        WHERE q.deleted_at IS NULL
          AND (q.number LIKE ? OR q.title LIKE ?)
        LIMIT ?`,
      [like, like, LIMIT_PER_TYPE]),

    all(env.DB,
      `SELECT ql.id, ql.title, ql.description, ql.quote_id,
              q.number AS quote_number, q.opportunity_id,
              o.number AS opp_number
         FROM quote_lines ql
         JOIN quotes q ON q.id = ql.quote_id
         JOIN opportunities o ON o.id = q.opportunity_id
        WHERE ql.deleted_at IS NULL
          AND (ql.title LIKE ? OR ql.description LIKE ?)
        LIMIT ?`,
      [like, like, LIMIT_PER_TYPE]),
  ]);

  // Log the search (fire-and-forget). Skip very short queries to reduce noise.
  const user = context.data?.user;
  if (user?.id) {
    const counts = {
      accounts: accounts.length, contacts: contacts.length,
      opportunities: opps.length, quotes: quotes.length, lines: lines.length,
    };
    context.waitUntil(
      audit(env.DB, {
        entityType: 'search',
        entityId: user.id,
        eventType: 'searched',
        user,
        summary: `Searched: "${q}"`,
        changes: { query: q, result_counts: counts },
      }).catch(() => {})
    );
  }

  const results = [];

  for (const a of accounts) {
    results.push({
      type: 'account',
      id: a.id,
      title: a.alias ? `${a.name} (${a.alias})` : a.name,
      subtitle: a.segment || '',
      url: `/accounts/${a.id}`,
    });
  }

  for (const c of contacts) {
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || '(no name)';
    results.push({
      type: 'contact',
      id: c.id,
      title: name,
      subtitle: [c.title, c.account_name].filter(Boolean).join(' — '),
      url: c.account_id ? `/accounts/${c.account_id}?tab=contacts` : '#',
    });
  }

  for (const o of opps) {
    results.push({
      type: 'opportunity',
      id: o.id,
      title: `${o.number} — ${o.title || '(untitled)'}`,
      subtitle: o.account_name || '',
      url: `/opportunities/${o.id}`,
    });
  }

  for (const q2 of quotes) {
    results.push({
      type: 'quote',
      id: q2.id,
      title: `${q2.number} Rev ${q2.revision}`,
      subtitle: q2.title || '',
      url: `/opportunities/${q2.opportunity_id}/quotes/${q2.id}`,
    });
  }

  for (const l of lines) {
    results.push({
      type: 'line item',
      id: l.id,
      title: l.title || l.description || '(no title)',
      subtitle: `on ${l.quote_number} (${l.opp_number})`,
      url: `/opportunities/${l.opportunity_id}/quotes/${l.quote_id}`,
    });
  }

  return json({ ok: true, results });
}

function json(data) {
  return new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
