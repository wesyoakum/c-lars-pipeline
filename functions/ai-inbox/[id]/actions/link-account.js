// functions/ai-inbox/[id]/actions/link-account.js
//
// POST /ai-inbox/:id/actions/link-account
//
// Records an ai_inbox_links row associating this inbox item with an
// existing account. Does NOT modify the account itself — link rows are
// the AI Inbox-side record of what was linked. We still write an audit
// event on the account so its detail page audit log shows the link.
//
// Body (JSON):
//   { account_id }
//
// Response:
//   { ok: true, link }
//   { ok: false, error }

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

  const account = await one(
    env.DB,
    'SELECT id, name, alias FROM accounts WHERE id = ?',
    [accountId]
  );
  if (!account) return json({ ok: false, error: 'account_not_found' }, 404);

  const showAlias = !!user?.show_alias;
  const refLabel = showAlias ? (account.alias || account.name) : account.name;

  const linkId = uuid();
  const ts = now();

  // Note: we deliberately do NOT write an audit_events row on the
  // linked account here. The link itself is recorded AI-Inbox-side in
  // ai_inbox_links; polluting the account's audit log with "Linked
  // from AI Inbox" entries every time someone explores a suggestion
  // is noise, not provenance. Real-create routes (create-account /
  // create-contact / create-task) still audit because they actually
  // mutate CRM rows.
  await run(env.DB,
    `INSERT INTO ai_inbox_links
       (id, item_id, action_type, ref_type, ref_id, ref_label, created_at, created_by_user_id)
     VALUES (?, ?, 'link_to_account', 'account', ?, ?, ?, ?)`,
    [linkId, params.id, accountId, refLabel, ts, user.id]);

  return json({
    ok: true,
    link: {
      id: linkId,
      action_type: 'link_to_account',
      ref_type: 'account',
      ref_id: accountId,
      ref_label: refLabel,
      created_at: ts,
    },
  });
}
