// functions/accounts/group/[slug]/rename.js
//
// POST /accounts/group/:slug/rename
//
// Renames a parent-group label by updating `accounts.parent_group`
// on every member account in one batch. Expects JSON
// `{ newLabel: "..." }`. Returns `{ ok, newSlug, newLabel }`.
//
// There is no `groups` table — the label IS the data — so renaming
// a group is just bulk-updating the member accounts. The slug is
// derived from the label so the URL changes too; the client-side
// inline-edit save reads `newSlug` from the response and navigates.

import { all, stmt, batch } from '../../../lib/db.js';
import { auditStmt } from '../../../lib/audit.js';
import { now } from '../../../lib/ids.js';
import { slugifyGroup } from '../../../lib/account-groups.js';

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const slug = params.slug;

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }

  const newLabel = typeof body.newLabel === 'string' ? body.newLabel.trim() : '';
  if (!newLabel) return json({ ok: false, error: 'Group name cannot be empty.' }, 400);

  // Find members by slug. We read the whole groups-eligible rowset and
  // filter client-side because slugifyGroup doesn't map cleanly to SQL
  // (matches findGroupMembers in lib/account-groups.js). The N here
  // is the number of grouped accounts — trivial.
  const allGrouped = await all(
    env.DB,
    `SELECT id, name, parent_group FROM accounts
      WHERE parent_group IS NOT NULL AND parent_group != ''`
  );
  const members = allGrouped.filter((r) => slugifyGroup(r.parent_group) === slug);
  if (members.length === 0) {
    return json({ ok: false, error: 'Group not found.' }, 404);
  }

  const oldLabel = members[0].parent_group;
  const newSlug = slugifyGroup(newLabel);
  if (!newSlug) {
    return json({ ok: false, error: 'New name does not form a valid group label.' }, 400);
  }

  // No-op rename: just echo back the current state. Prevents a pile
  // of noisy audit entries when the user "saves" the same text.
  if (newLabel === oldLabel) {
    return json({ ok: true, newSlug: slug, newLabel: oldLabel, changed: 0 });
  }

  // If the new slug matches an EXISTING different group, refuse —
  // merging two groups should be a deliberate action done by editing
  // individual accounts, not a silent consequence of a rename.
  if (newSlug !== slug) {
    const collidingGroup = allGrouped
      .filter((r) => r.parent_group !== oldLabel)
      .some((r) => slugifyGroup(r.parent_group) === newSlug);
    if (collidingGroup) {
      return json({
        ok: false,
        error: `Another group with the name "${newLabel}" already exists. Rename that one first, or merge from the account detail pages.`,
      }, 409);
    }
  }

  const ts = now();
  const statements = members.map((m) =>
    stmt(env.DB,
      `UPDATE accounts SET parent_group = ?, updated_at = ? WHERE id = ?`,
      [newLabel, ts, m.id])
  );
  // One audit row per affected account so the account history reflects
  // the rename without wading through a single monster event.
  members.forEach((m) => {
    statements.push(auditStmt(env.DB, {
      entityType: 'account',
      entityId: m.id,
      eventType: 'updated',
      user,
      summary: `Group renamed: "${oldLabel}" \u2192 "${newLabel}"`,
      changes: { parent_group: { from: oldLabel, to: newLabel } },
    }));
  });

  await batch(env.DB, statements);

  return json({
    ok: true,
    newSlug,
    newLabel,
    changed: members.length,
  });
}
