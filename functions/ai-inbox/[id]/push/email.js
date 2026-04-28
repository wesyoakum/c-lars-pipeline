// functions/ai-inbox/[id]/push/email.js
//
// POST /ai-inbox/:id/push/email
//
// Updates the email field on an account or contact. Auto-associates
// the entry to the target. Same overwrite-protection as push/phone:
// if there's already a different email, return 409 unless caller
// passes force:true.
//
// Body (JSON):
//   { ref_type, ref_id, email, force? }

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
  const email = String(payload.email || '').trim();
  const force = !!payload.force;

  if (refType !== 'account' && refType !== 'contact') {
    return json({ ok: false, error: 'email_only_supports_account_or_contact' }, 400);
  }
  if (!refId) return json({ ok: false, error: 'ref_id_required' }, 400);
  if (!email) return json({ ok: false, error: 'email_required' }, 400);

  const ctx = await loadPushContext(env, user, params.id, refType, refId);
  if (ctx.error) return json({ ok: false, error: ctx.error }, ctx.status || 400);

  const table = refType === 'contact' ? 'contacts' : 'accounts';
  const current = await one(env.DB,
    `SELECT email AS value FROM ${table} WHERE id = ?`, [refId]);
  const existing = (current?.value || '').trim();

  if (existing && existing.toLowerCase() !== email.toLowerCase() && !force) {
    return json({
      ok: false,
      error: 'email_already_set',
      existing,
      requested: email,
      hint: 'pass force:true to replace',
    }, 409);
  }

  const ts = now();
  const alreadyAssoc = await isAlreadyAssociated(env.DB, params.id, refType, refId);
  const pushAction = `push_email_to_${refType}`;
  const pushLinks = buildPushLinkStatements(env.DB, user, params.id, {
    action_type: pushAction,
    ref_type: refType,
    ref_id: refId,
    ref_label: ctx.refLabel,
  }, alreadyAssoc);

  const stmts = [
    stmt(env.DB,
      `UPDATE ${table} SET email = ?, updated_at = ? WHERE id = ?`,
      [email, ts, refId]),
    auditStmt(env.DB, {
      entityType: refType,
      entityId: refId,
      eventType: 'updated',
      user,
      summary: `Pushed email from AI Inbox: ${email}`,
      changes: { email: { from: existing || null, to: email } },
    }),
    ...pushLinks.statements,
  ];
  await batch(env.DB, stmts);

  return json({
    ok: true,
    previous: existing || null,
    value: email,
    links: {
      associate: pushLinks.associateLinkRow,
      push: pushLinks.pushLinkRow,
    },
  });
}
