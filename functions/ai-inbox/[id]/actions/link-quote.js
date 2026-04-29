// functions/ai-inbox/[id]/actions/link-quote.js
//
// POST /ai-inbox/:id/actions/link-quote
//
// Records an ai_inbox_links row associating this entry with an
// existing quote. Mirrors link-account.js / link-opportunity.js —
// the underlying entity is not modified; we just write the
// AI Inbox-side link. No audit_events write per the v0.308 audit-
// pollution policy (matches link-account / link-opportunity).
//
// Body (JSON):
//   { quote_id }
//
// Response:
//   { ok: true, link }

import { one, run } from '../../../lib/db.js';
import { uuid, now } from '../../../lib/ids.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;

  const entry = await one(
    env.DB,
    'SELECT id FROM ai_inbox_items WHERE id = ? AND user_id = ?',
    [params.id, user.id]
  );
  if (!entry) return json({ ok: false, error: 'not_found' }, 404);

  let payload;
  try { payload = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const quoteId = (payload.quote_id || '').trim();
  if (!quoteId) return json({ ok: false, error: 'quote_id_required' }, 400);

  const quote = await one(
    env.DB,
    `SELECT q.id, q.number, q.title,
            o.number AS opp_number, o.title AS opp_title,
            a.name AS account_name, a.alias AS account_alias
       FROM quotes q
       LEFT JOIN opportunities o ON o.id = q.opportunity_id
       LEFT JOIN accounts a ON a.id = o.account_id
      WHERE q.id = ?`,
    [quoteId]
  );
  if (!quote) return json({ ok: false, error: 'quote_not_found' }, 404);

  const showAlias = !!user?.show_alias;
  const acctLabel = (showAlias && quote.account_alias) ? quote.account_alias : (quote.account_name || '');
  const refLabel = `${quote.number}${quote.title ? ' · ' + quote.title : ''}${acctLabel ? ' · ' + acctLabel : ''}`;

  const linkId = uuid();
  const ts = now();

  await run(env.DB,
    `INSERT INTO ai_inbox_links
       (id, item_id, action_type, ref_type, ref_id, ref_label, created_at, created_by_user_id)
     VALUES (?, ?, 'link_to_quote', 'quote', ?, ?, ?, ?)`,
    [linkId, params.id, quoteId, refLabel, ts, user.id]);

  return json({
    ok: true,
    link: {
      id: linkId,
      action_type: 'link_to_quote',
      ref_type: 'quote',
      ref_id: quoteId,
      ref_label: refLabel,
      created_at: ts,
    },
  });
}
