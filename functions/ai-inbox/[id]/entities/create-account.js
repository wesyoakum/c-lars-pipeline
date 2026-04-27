// functions/ai-inbox/[id]/entities/create-account.js
//
// POST /ai-inbox/:id/entities/create-account
//
// Creates a new account from an unresolved organization mention.
// Records a user_overridden=1 match row pointing to it AND a
// create_account link row, so the detail page renders the new account
// as a confirmed match and the action history shows the creation.
//
// Body (JSON):
//   { mention_idx, name, alias?, segment?, mention_text? }

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

  const item = await one(
    env.DB,
    'SELECT id FROM ai_inbox_items WHERE id = ? AND user_id = ?',
    [params.id, user.id]
  );
  if (!item) return json({ ok: false, error: 'not_found' }, 404);

  let payload;
  try { payload = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const name = (payload.name || '').trim();
  if (!name) return json({ ok: false, error: 'name_required' }, 400);

  const alias = (payload.alias || '').trim() || null;
  const segment = (payload.segment || '').trim() || null;
  const mentionIdx = Number.isInteger(payload.mention_idx) ? payload.mention_idx : 0;
  const mentionText = String(payload.mention_text || name);

  const accountId = uuid();
  const linkId = uuid();
  const matchId = uuid();
  const ts = now();
  const refLabel = (user?.show_alias && alias) ? alias : name;

  await batch(env.DB, [
    stmt(env.DB,
      `INSERT INTO accounts
         (id, name, alias, segment, is_active, created_at, updated_at, created_by_user_id)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
      [accountId, name, alias, segment, ts, ts, user.id]),
    stmt(env.DB,
      `DELETE FROM ai_inbox_entity_matches
        WHERE item_id = ? AND mention_kind = 'organization' AND mention_idx = ?`,
      [params.id, mentionIdx]),
    stmt(env.DB,
      `INSERT INTO ai_inbox_entity_matches
         (id, item_id, mention_kind, mention_text, mention_idx,
          ref_type, ref_id, ref_label, score, rank,
          auto_resolved, user_overridden, created_at, updated_at)
       VALUES (?, ?, 'organization', ?, ?, 'account', ?, ?, 200, 1, 0, 1, ?, ?)`,
      [matchId, params.id, mentionText, mentionIdx, accountId, refLabel, ts, ts]),
    stmt(env.DB,
      `INSERT INTO ai_inbox_links
         (id, item_id, action_type, ref_type, ref_id, ref_label, created_at, created_by_user_id)
       VALUES (?, ?, 'create_account', 'account', ?, ?, ?, ?)`,
      [linkId, params.id, accountId, refLabel, ts, user.id]),
    auditStmt(env.DB, {
      entityType: 'account',
      entityId: accountId,
      eventType: 'created',
      user,
      summary: `Created account from AI Inbox: ${name}`,
    }),
  ]);

  return json({
    ok: true,
    account: { id: accountId, name, alias },
    match: {
      id: matchId,
      mention_kind: 'organization',
      mention_text: mentionText,
      mention_idx: mentionIdx,
      ref_type: 'account',
      ref_id: accountId,
      ref_label: refLabel,
      score: 200,
      rank: 1,
      auto_resolved: 0,
      user_overridden: 1,
    },
    link: {
      id: linkId,
      action_type: 'create_account',
      ref_type: 'account',
      ref_id: accountId,
      ref_label: refLabel,
      created_at: ts,
    },
  });
}
