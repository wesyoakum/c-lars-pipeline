// functions/ai-inbox/[id]/entities/match.js
//
// POST /ai-inbox/:id/entities/match
//
// Manual confirm: the user picked a candidate (or selected a different
// account/contact via the typeahead) and wants this match locked in.
// Deletes any existing match rows for this (mention_kind, mention_idx)
// and inserts a single user_overridden=1, rank=1 row.
//
// Body (JSON):
//   { mention_kind, mention_text?, mention_idx, ref_type, ref_id }
//
// Response:
//   { ok: true, match }

import { one, stmt, batch } from '../../../lib/db.js';
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

  const mentionKind = String(payload.mention_kind || '');
  const mentionIdx = Number.isInteger(payload.mention_idx) ? payload.mention_idx : 0;
  const refType = String(payload.ref_type || '');
  const refId = String(payload.ref_id || '');
  const mentionText = String(payload.mention_text || '');

  if (mentionKind !== 'person' && mentionKind !== 'organization') {
    return json({ ok: false, error: 'bad_mention_kind' }, 400);
  }
  if (!refId) return json({ ok: false, error: 'ref_id_required' }, 400);

  // Look up label from the actual entity, ignoring whatever the client
  // sent — the server is the source of truth for display strings.
  let refLabel = '';
  if (refType === 'account') {
    const a = await one(env.DB, 'SELECT name, alias FROM accounts WHERE id = ?', [refId]);
    if (!a) return json({ ok: false, error: 'account_not_found' }, 404);
    refLabel = (user?.show_alias && a.alias) ? a.alias : a.name;
  } else if (refType === 'contact') {
    const c = await one(env.DB,
      `SELECT c.first_name, c.last_name, a.name AS account_name, a.alias AS account_alias
         FROM contacts c LEFT JOIN accounts a ON a.id = c.account_id
        WHERE c.id = ?`, [refId]);
    if (!c) return json({ ok: false, error: 'contact_not_found' }, 404);
    const full = `${c.first_name || ''} ${c.last_name || ''}`.trim();
    const orgPart = c.account_name ? ` · ${c.account_alias || c.account_name}` : '';
    refLabel = full + orgPart;
  } else {
    return json({ ok: false, error: 'bad_ref_type' }, 400);
  }

  const matchId = uuid();
  const ts = now();

  await batch(env.DB, [
    stmt(env.DB,
      `DELETE FROM ai_inbox_entity_matches
        WHERE item_id = ? AND mention_kind = ? AND mention_idx = ?`,
      [params.id, mentionKind, mentionIdx]),
    stmt(env.DB,
      `INSERT INTO ai_inbox_entity_matches
         (id, item_id, mention_kind, mention_text, mention_idx,
          ref_type, ref_id, ref_label, score, rank,
          auto_resolved, user_overridden, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 200, 1, 0, 1, ?, ?)`,
      [matchId, params.id, mentionKind, mentionText, mentionIdx,
       refType, refId, refLabel, ts, ts]),
  ]);

  return json({
    ok: true,
    match: {
      id: matchId,
      mention_kind: mentionKind,
      mention_text: mentionText,
      mention_idx: mentionIdx,
      ref_type: refType,
      ref_id: refId,
      ref_label: refLabel,
      score: 200,
      rank: 1,
      auto_resolved: 0,
      user_overridden: 1,
    },
  });
}
