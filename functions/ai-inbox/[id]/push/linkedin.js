// functions/ai-inbox/[id]/push/linkedin.js
//
// POST /ai-inbox/:id/push/linkedin
//
// Writes a LinkedIn URL onto a contact and marks it as ai_suggested
// so the contacts list / detail page can render it as a recommendation
// pending user confirmation. Auto-associates the entry to the contact.
//
// Same overwrite-protection as push/email: if the contact already has
// a different LinkedIn URL stored, return 409 unless the caller passes
// force:true. URL comparison is case-insensitive and ignores trailing
// slashes / "www." / protocol drift.
//
// Body (JSON):
//   { ref_type: 'contact', ref_id, linkedin, force? }
//
// LinkedIn is contact-only — accounts use a `website` field instead.

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

// Lightweight client-side normalization mirroring the LLM-output
// normalizer in prompts.js. Lets us compare the suggestion against
// whatever is currently stored before deciding to overwrite.
function normalizeForCompare(s) {
  if (!s) return '';
  let v = String(s).trim().toLowerCase();
  v = v.replace(/^https?:\/\//, '');
  v = v.replace(/^(www\.|m\.)/, '');
  v = v.replace(/\/+$/, '');
  v = v.split('?')[0].split('#')[0];
  return v;
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;

  let payload;
  try { payload = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const refType = String(payload.ref_type || '').trim();
  const refId = String(payload.ref_id || '').trim();
  const linkedin = String(payload.linkedin || '').trim();
  const force = !!payload.force;

  if (refType !== 'contact') {
    return json({ ok: false, error: 'linkedin_only_supports_contact' }, 400);
  }
  if (!refId) return json({ ok: false, error: 'ref_id_required' }, 400);
  if (!linkedin) return json({ ok: false, error: 'linkedin_required' }, 400);

  const ctx = await loadPushContext(env, user, params.id, refType, refId);
  if (ctx.error) return json({ ok: false, error: ctx.error }, ctx.status || 400);

  const current = await one(env.DB,
    `SELECT linkedin_url AS value, linkedin_url_source AS source
       FROM contacts WHERE id = ?`, [refId]);
  const existing = (current?.value || '').trim();

  if (existing && normalizeForCompare(existing) !== normalizeForCompare(linkedin) && !force) {
    return json({
      ok: false,
      error: 'linkedin_already_set',
      existing,
      requested: linkedin,
      hint: 'pass force:true to replace',
    }, 409);
  }

  const ts = now();
  const alreadyAssoc = await isAlreadyAssociated(env.DB, params.id, refType, refId);
  const pushAction = `push_linkedin_to_${refType}`;
  const pushLinks = buildPushLinkStatements(env.DB, user, params.id, {
    action_type: pushAction,
    ref_type: refType,
    ref_id: refId,
    ref_label: ctx.refLabel,
  }, alreadyAssoc);

  const stmts = [
    stmt(env.DB,
      `UPDATE contacts
          SET linkedin_url = ?, linkedin_url_source = 'ai_suggested', updated_at = ?
        WHERE id = ?`,
      [linkedin, ts, refId]),
    auditStmt(env.DB, {
      entityType: refType,
      entityId: refId,
      eventType: 'updated',
      user,
      summary: `Pushed LinkedIn URL from AI Inbox: ${linkedin}`,
      changes: { linkedin_url: { from: existing || null, to: linkedin } },
    }),
    ...pushLinks.statements,
  ];
  await batch(env.DB, stmts);

  return json({
    ok: true,
    previous: existing || null,
    value: linkedin,
    source: 'ai_suggested',
    links: {
      associate: pushLinks.associateLinkRow,
      push: pushLinks.pushLinkRow,
    },
  });
}
