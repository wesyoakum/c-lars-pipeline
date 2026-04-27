// functions/ai-inbox/[id]/entities/create-contact.js
//
// POST /ai-inbox/:id/entities/create-contact
//
// Creates a new contact from an unresolved person mention. Requires an
// account_id (the contacts table has a NOT NULL FK to accounts) — the
// UI pre-fills it with whichever organization on this item has been
// resolved/created, and the user can change it.
//
// Body (JSON):
//   { mention_idx, account_id, first_name, last_name, email?, title?,
//     phone?, mention_text? }

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

  const accountId = (payload.account_id || '').trim();
  if (!accountId) return json({ ok: false, error: 'account_id_required' }, 400);

  const account = await one(env.DB,
    'SELECT id, name, alias FROM accounts WHERE id = ?', [accountId]);
  if (!account) return json({ ok: false, error: 'account_not_found' }, 404);

  const firstName = (payload.first_name || '').trim() || null;
  const lastName = (payload.last_name || '').trim() || null;
  if (!firstName && !lastName) {
    return json({ ok: false, error: 'name_required' }, 400);
  }
  const email = (payload.email || '').trim() || null;
  const title = (payload.title || '').trim() || null;
  const phone = (payload.phone || '').trim() || null;
  const mentionIdx = Number.isInteger(payload.mention_idx) ? payload.mention_idx : 0;
  const mentionText = String(payload.mention_text || `${firstName || ''} ${lastName || ''}`.trim());

  const contactId = uuid();
  const linkId = uuid();
  const matchId = uuid();
  const ts = now();
  const fullName = `${firstName || ''} ${lastName || ''}`.trim();
  const orgPart = ` · ${(user?.show_alias && account.alias) ? account.alias : account.name}`;
  const refLabel = fullName + orgPart;

  await batch(env.DB, [
    stmt(env.DB,
      `INSERT INTO contacts
         (id, account_id, first_name, last_name, title, email, phone,
          is_primary, created_at, updated_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [contactId, accountId, firstName, lastName, title, email, phone,
       ts, ts, user.id]),
    stmt(env.DB,
      `DELETE FROM ai_inbox_entity_matches
        WHERE item_id = ? AND mention_kind = 'person' AND mention_idx = ?`,
      [params.id, mentionIdx]),
    stmt(env.DB,
      `INSERT INTO ai_inbox_entity_matches
         (id, item_id, mention_kind, mention_text, mention_idx,
          ref_type, ref_id, ref_label, score, rank,
          auto_resolved, user_overridden, created_at, updated_at)
       VALUES (?, ?, 'person', ?, ?, 'contact', ?, ?, 200, 1, 0, 1, ?, ?)`,
      [matchId, params.id, mentionText, mentionIdx, contactId, refLabel, ts, ts]),
    stmt(env.DB,
      `INSERT INTO ai_inbox_links
         (id, item_id, action_type, ref_type, ref_id, ref_label, created_at, created_by_user_id)
       VALUES (?, ?, 'create_contact', 'contact', ?, ?, ?, ?)`,
      [linkId, params.id, contactId, refLabel, ts, user.id]),
    auditStmt(env.DB, {
      entityType: 'contact',
      entityId: contactId,
      eventType: 'created',
      user,
      summary: `Created contact from AI Inbox: ${fullName || email || 'unnamed'}`,
    }),
  ]);

  return json({
    ok: true,
    contact: {
      id: contactId, first_name: firstName, last_name: lastName,
      email, title, phone, account_id: accountId,
    },
    match: {
      id: matchId,
      mention_kind: 'person',
      mention_text: mentionText,
      mention_idx: mentionIdx,
      ref_type: 'contact',
      ref_id: contactId,
      ref_label: refLabel,
      score: 200,
      rank: 1,
      auto_resolved: 0,
      user_overridden: 1,
    },
    link: {
      id: linkId,
      action_type: 'create_contact',
      ref_type: 'contact',
      ref_id: contactId,
      ref_label: refLabel,
      created_at: ts,
    },
  });
}
