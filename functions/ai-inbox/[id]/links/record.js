// functions/ai-inbox/[id]/links/record.js
//
// POST /ai-inbox/:id/links/record
//
// v3 helper. Used by the in-context-create flow: AI Inbox opens a CRM
// wizard (task / account / contact), the wizard creates the entity via
// its own POST handler, and on success the AI Inbox JS listens for the
// `pipeline:wizard-success` event and calls THIS endpoint to record an
// ai_inbox_links row pointing at the just-created entity.
//
// We don't audit on the underlying entity here because the wizard's
// own POST handler already wrote a 'created' audit event. Recording a
// link is purely an AI Inbox-side concern.
//
// Body (JSON):
//   { action_type, ref_type, ref_id, ref_label }
//   - action_type: 'create_task' | 'create_account' | 'create_contact' | 'link_to_account' | ...
//   - ref_type:    'activity' | 'account' | 'contact' | ...
//   - ref_id:      the new entity id
//   - ref_label:   display label (denormalized so the link survives
//                  rename / delete of the underlying entity)
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

const ALLOWED_ACTION_TYPES = new Set([
  'create_task',
  'create_account',
  'create_contact',
  'create_opportunity',
  'create_quote',
  'create_job',
  'create_reminder',
  'link_to_account',
  'link_to_opportunity',
  'link_to_quote',
  'archive',
]);

const ALLOWED_REF_TYPES = new Set([
  'activity', 'account', 'contact', 'opportunity', 'quote', 'job',
]);

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;

  // Verify ownership of the inbox entry.
  const entry = await one(
    env.DB,
    'SELECT id FROM ai_inbox_items WHERE id = ? AND user_id = ?',
    [params.id, user.id]
  );
  if (!entry) return json({ ok: false, error: 'not_found' }, 404);

  let payload;
  try { payload = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const actionType = String(payload.action_type || '').trim();
  if (!ALLOWED_ACTION_TYPES.has(actionType)) {
    return json({ ok: false, error: 'bad_action_type' }, 400);
  }

  const refType = String(payload.ref_type || '').trim();
  if (refType && !ALLOWED_REF_TYPES.has(refType)) {
    return json({ ok: false, error: 'bad_ref_type' }, 400);
  }

  const refId = (payload.ref_id || '').trim() || null;
  const refLabel = String(payload.ref_label || '').trim().slice(0, 200) || null;

  // archive is the one allowed action with no ref_type/ref_id; everything
  // else needs both.
  if (actionType !== 'archive' && (!refType || !refId)) {
    return json({ ok: false, error: 'ref_required' }, 400);
  }

  const linkId = uuid();
  const ts = now();

  await run(env.DB,
    `INSERT INTO ai_inbox_links
       (id, item_id, action_type, ref_type, ref_id, ref_label, created_at, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [linkId, params.id, actionType, refType || null, refId, refLabel, ts, user.id]);

  return json({
    ok: true,
    link: {
      id: linkId,
      action_type: actionType,
      ref_type: refType || null,
      ref_id: refId,
      ref_label: refLabel,
      created_at: ts,
    },
  });
}
