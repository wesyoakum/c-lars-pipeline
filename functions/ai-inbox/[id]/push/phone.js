// functions/ai-inbox/[id]/push/phone.js
//
// POST /ai-inbox/:id/push/phone
//
// Updates the phone field on an account or contact with a value
// captured from the entry. Auto-associates the entry to the target.
// Refuses to silently overwrite a non-empty phone — caller must pass
// `force: true` to replace, otherwise we 409 with the current value.
//
// Body (JSON):
//   { ref_type, ref_id, phone, force?, source? }
//   - ref_type: 'account' | 'contact'
//   - ref_id:   target id
//   - phone:    the new phone value (will be trimmed)
//   - force:    true to replace a non-empty existing phone
//   - source:   optional: 'mobile' to write to contacts.mobile instead
//               of contacts.phone (only meaningful for contacts)

import { one, stmt, batch } from '../../../lib/db.js';
import { auditStmt } from '../../../lib/audit.js';
import { now } from '../../../lib/ids.js';
import {
  loadPushContext,
  isAlreadyAssociated,
  buildPushLinkStatements,
} from '../../lib/push-helpers.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;

  let payload;
  try { payload = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const refType = String(payload.ref_type || '').trim();
  const refId = String(payload.ref_id || '').trim();
  const phone = String(payload.phone || '').trim();
  const force = !!payload.force;
  const source = String(payload.source || '').trim().toLowerCase();

  if (refType !== 'account' && refType !== 'contact') {
    return json({ ok: false, error: 'phone_only_supports_account_or_contact' }, 400);
  }
  if (!refId) return json({ ok: false, error: 'ref_id_required' }, 400);
  if (!phone) return json({ ok: false, error: 'phone_required' }, 400);

  const ctx = await loadPushContext(env, user, params.id, refType, refId);
  if (ctx.error) return json({ ok: false, error: ctx.error }, ctx.status || 400);

  // Look up the column we're writing to (phone or mobile, contacts only).
  const phoneColumn = refType === 'contact' && source === 'mobile' ? 'mobile' : 'phone';
  const table = refType === 'contact' ? 'contacts' : 'accounts';
  const current = await one(env.DB,
    `SELECT ${phoneColumn} AS value FROM ${table} WHERE id = ?`, [refId]);
  const existing = (current?.value || '').trim();

  if (existing && existing !== phone && !force) {
    return json({
      ok: false,
      error: 'phone_already_set',
      existing,
      requested: phone,
      hint: 'pass force:true to replace',
    }, 409);
  }

  const ts = now();
  const alreadyAssoc = await isAlreadyAssociated(env.DB, params.id, refType, refId);
  const pushAction = `push_phone_to_${refType}`;
  const pushLinks = buildPushLinkStatements(env.DB, user, params.id, {
    action_type: pushAction,
    ref_type: refType,
    ref_id: refId,
    ref_label: ctx.refLabel,
  }, alreadyAssoc);

  const updateSql = `UPDATE ${table} SET ${phoneColumn} = ?, updated_at = ? WHERE id = ?`;
  const stmts = [
    stmt(env.DB, updateSql, [phone, ts, refId]),
    auditStmt(env.DB, {
      entityType: refType,
      entityId: refId,
      eventType: 'updated',
      user,
      summary: `Pushed ${phoneColumn} from AI Inbox: ${phone}`,
      changes: { [phoneColumn]: { from: existing || null, to: phone } },
    }),
    ...pushLinks.statements,
  ];
  await batch(env.DB, stmts);

  return json({
    ok: true,
    column: phoneColumn,
    previous: existing || null,
    value: phone,
    links: {
      associate: pushLinks.associateLinkRow,
      push: pushLinks.pushLinkRow,
    },
  });
}
