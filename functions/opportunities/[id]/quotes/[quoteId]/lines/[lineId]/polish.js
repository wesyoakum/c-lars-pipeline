// functions/opportunities/[id]/quotes/[quoteId]/lines/[lineId]/polish.js
//
// POST /opportunities/:id/quotes/:quoteId/lines/:lineId/polish
//
// AI-polish the line's title / description / line_notes in one call.
// Does NOT auto-apply — returns the polished triple as JSON; the
// caller (Alpine handler on the quote detail page) shows a quick
// confirm UI before patching the row.
//
// 200 → { ok: true, polished: { title, description, line_notes } }
// 4xx → { ok: false, error }
//
// The line itself is not modified by this route. Apply happens via
// the existing /opportunities/:id/quotes/:quoteId/lines/:lineId/patch
// endpoint, with the user reviewing first.

import { one } from '../../../../../../lib/db.js';
import { polishLine } from '../../../../../../lib/quote-line-polish.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  if (!user) return json({ ok: false, error: 'unauthenticated' }, 401);

  const { id: oppId, quoteId, lineId } = params;

  // Pull the line + the surrounding context the prompt cares about.
  const row = await one(env.DB,
    `SELECT ql.id, ql.title, ql.description, ql.line_notes, ql.part_number,
            q.id AS quote_id, q.opportunity_id, q.quote_type,
            o.number AS opp_number, o.title AS opp_title, o.account_id,
            a.name AS account_name
       FROM quote_lines ql
       JOIN quotes q         ON q.id = ql.quote_id
       LEFT JOIN opportunities o ON o.id = q.opportunity_id
       LEFT JOIN accounts a      ON a.id = o.account_id
      WHERE ql.id = ?`,
    [lineId]);

  if (!row) return json({ ok: false, error: 'line_not_found' }, 404);
  if (row.quote_id !== quoteId || row.opportunity_id !== oppId) {
    return json({ ok: false, error: 'line_url_mismatch' }, 400);
  }

  let polished;
  try {
    polished = await polishLine(env, {
      title:        row.title || '',
      description:  row.description || '',
      line_notes:   row.line_notes || '',
      part_number:  row.part_number || '',
      account_name: row.account_name || '',
      opp_number:   row.opp_number || '',
      opp_title:    row.opp_title || '',
      quote_type:   row.quote_type || '',
    });
  } catch (err) {
    console.error('polishLine failed:', err?.message || err);
    return json({
      ok: false,
      error: 'polish_failed',
      detail: err?.message || String(err),
    }, 500);
  }

  return json({
    ok: true,
    polished,
    original: {
      title:       row.title || '',
      description: row.description || '',
      line_notes:  row.line_notes || '',
    },
  });
}
