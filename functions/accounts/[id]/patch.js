// functions/accounts/[id]/patch.js
//
// POST /accounts/:id/patch — inline field save (JSON).
//
// Accepts { field, value } and updates a single field on the account.
// Returns JSON { ok, field, value, error? }.

import { one, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { now } from '../../lib/ids.js';
import { checkInactivateBlockers, summarizeBlockers } from '../../lib/inactivate-blocker.js';

const PATCHABLE = new Set([
  'name', 'alias', 'segment', 'phone', 'website', 'notes', 'owner_user_id',
  'parent_group', 'is_active',
]);

function coerce(field, raw) {
  // is_active is a NOT NULL 0/1 integer — accept 'active'/'inactive'
  // from the inline-edit select, plus the usual 0/1/'0'/'1'/bool forms.
  if (field === 'is_active') {
    if (raw === 'inactive' || raw === 0 || raw === '0' || raw === false || raw === 'false' || raw === 'off') {
      return 0;
    }
    if (raw === '' || raw === null || raw === undefined) return 1;
    return 1;
  }
  const v = typeof raw === 'string' ? raw.trim() : raw;
  if (v === '' || v === null || v === undefined) return null;
  return v;
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const accountId = params.id;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const { field, value: rawValue } = body;
  if (!field || !PATCHABLE.has(field)) {
    return json({ ok: false, error: `Field "${field}" is not editable` }, 400);
  }

  // name is required — don't allow blanking it
  if (field === 'name') {
    const trimmed = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (!trimmed) {
      return json({ ok: false, error: 'Name is required' }, 400);
    }
  }

  const before = await one(env.DB, `SELECT * FROM accounts WHERE id = ?`, [accountId]);
  if (!before) return json({ ok: false, error: 'Not found' }, 404);

  let newValue = coerce(field, rawValue);

  // Blocker gate: flipping is_active 1 → 0 is the account-level
  // inactivation action. Refuse when pending tasks or active opps
  // would be orphaned. The inline-edit client is already AJAX, so
  // it receives the 409 and surfaces the blocker list via the
  // shared modal.
  if (field === 'is_active' && before.is_active === 1 && newValue === 0) {
    const blockers = await checkInactivateBlockers(env.DB, 'account', accountId);
    if (blockers.length > 0) {
      return json({
        ok: false,
        error: `Cannot mark inactive \u2014 ${summarizeBlockers(blockers)}.`,
        blockers,
      }, 409);
    }
  }

  // Alias must never be empty — the per-user "Show aliases" toggle relies
  // on every account having a non-empty alias (see migration 0034). If
  // the user clears the alias inline, fall back to the legal name rather
  // than allowing null.
  if (field === 'alias' && (newValue === null || newValue === '')) {
    newValue = before.name;
  }
  const ts = now();

  const changes = {};
  if (before[field] !== newValue) {
    changes[field] = { from: before[field], to: newValue };
  }

  try {
    await batch(env.DB, [
      stmt(env.DB, `UPDATE accounts SET ${field} = ?, updated_at = ? WHERE id = ?`, [newValue, ts, accountId]),
      auditStmt(env.DB, {
        entityType: 'account',
        entityId: accountId,
        eventType: 'updated',
        user,
        summary: `Updated ${field}`,
        changes,
      }),
    ]);
  } catch (e) {
    return json({ ok: false, error: String(e.message ?? e) }, 500);
  }

  // For is_active we echo back the string form ('active'/'inactive')
  // so the inline-edit client can match it against ACTIVE_OPTIONS when
  // updating the display — matching the value the client originally sent.
  const responseValue =
    field === 'is_active' ? (newValue ? 'active' : 'inactive') : newValue;
  return json({ ok: true, field, value: responseValue });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
