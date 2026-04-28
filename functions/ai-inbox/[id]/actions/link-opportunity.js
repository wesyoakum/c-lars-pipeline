// functions/ai-inbox/[id]/actions/link-opportunity.js
//
// POST /ai-inbox/:id/actions/link-opportunity
//
// Records an ai_inbox_links row associating this entry with an
// existing opportunity. Mirrors link-account.js exactly — the
// underlying entity is not modified; we just write the AI Inbox-side
// link record + an audit event on the opportunity so its detail
// page's audit log shows the connection.
//
// Body (JSON):
//   { opportunity_id }
//
// Response:
//   { ok: true, link }

import { one, stmt, batch } from '../../../lib/db.js';
import { auditStmt } from '../../../lib/audit.js';
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

  const opportunityId = (payload.opportunity_id || '').trim();
  if (!opportunityId) return json({ ok: false, error: 'opportunity_id_required' }, 400);

  const opp = await one(
    env.DB,
    `SELECT o.id, o.number, o.title, a.name AS account_name, a.alias AS account_alias
       FROM opportunities o LEFT JOIN accounts a ON a.id = o.account_id
      WHERE o.id = ?`,
    [opportunityId]
  );
  if (!opp) return json({ ok: false, error: 'opportunity_not_found' }, 404);

  const showAlias = !!user?.show_alias;
  const acctLabel = showAlias && opp.account_alias ? opp.account_alias : (opp.account_name || '');
  const refLabel = `OPP-${opp.number}${opp.title ? ' · ' + opp.title : ''}${acctLabel ? ' · ' + acctLabel : ''}`;

  const linkId = uuid();
  const ts = now();

  await batch(env.DB, [
    stmt(env.DB,
      `INSERT INTO ai_inbox_links
         (id, item_id, action_type, ref_type, ref_id, ref_label, created_at, created_by_user_id)
       VALUES (?, ?, 'link_to_opportunity', 'opportunity', ?, ?, ?, ?)`,
      [linkId, params.id, opportunityId, refLabel, ts, user.id]),
    auditStmt(env.DB, {
      entityType: 'opportunity',
      entityId: opportunityId,
      eventType: 'updated',
      user,
      summary: 'Linked from AI Inbox',
    }),
  ]);

  return json({
    ok: true,
    link: {
      id: linkId,
      action_type: 'link_to_opportunity',
      ref_type: 'opportunity',
      ref_id: opportunityId,
      ref_label: refLabel,
      created_at: ts,
    },
  });
}
