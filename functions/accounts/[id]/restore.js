// functions/accounts/[id]/restore.js
//
// POST /accounts/:id/restore — undo a soft-deleted account.
// Restores all children that share the same deleted_at timestamp.

import { one, all, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { restoreStmt, restoreChildrenStmt } from '../../lib/soft-delete.js';
import { redirectWithFlash } from '../../lib/http.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const accountId = params.id;

  const account = await one(
    env.DB,
    `SELECT id, name, deleted_at FROM accounts WHERE id = ? AND deleted_at IS NOT NULL`,
    [accountId]
  );
  if (!account) {
    return redirectWithFlash('/accounts', 'Account not found or not deleted.', 'error');
  }

  const ts = account.deleted_at;
  const statements = [];

  // Restore cascade-deleted opps and their children
  const opps = await all(
    env.DB,
    `SELECT id FROM opportunities WHERE account_id = ? AND deleted_at = ?`,
    [accountId, ts]
  );
  for (const o of opps) {
    // Restore jobs under this opp that were cascade-deleted
    const jobs = await all(
      env.DB,
      `SELECT id FROM jobs WHERE opportunity_id = ? AND deleted_at = ?`,
      [o.id, ts]
    );
    for (const j of jobs) {
      statements.push(restoreChildrenStmt(env.DB, 'change_orders', 'job_id', j.id, ts));
      statements.push(restoreChildrenStmt(env.DB, 'activities', 'job_id', j.id, ts));
      statements.push(restoreChildrenStmt(env.DB, 'documents', 'job_id', j.id, ts));
      statements.push(restoreChildrenStmt(env.DB, 'cost_builds', 'job_id', j.id, ts));
      statements.push(restoreStmt(env.DB, 'jobs', j.id));
    }

    // Quote_lines via their parent quotes
    const quotes = await all(
      env.DB,
      `SELECT id FROM quotes WHERE opportunity_id = ? AND deleted_at = ?`,
      [o.id, ts]
    );
    for (const q of quotes) {
      statements.push(restoreChildrenStmt(env.DB, 'quote_lines', 'quote_id', q.id, ts));
    }

    // Restore opp children
    statements.push(restoreChildrenStmt(env.DB, 'quotes', 'opportunity_id', o.id, ts));
    statements.push(restoreChildrenStmt(env.DB, 'activities', 'opportunity_id', o.id, ts));
    statements.push(restoreChildrenStmt(env.DB, 'documents', 'opportunity_id', o.id, ts));
    statements.push(restoreChildrenStmt(env.DB, 'cost_builds', 'opportunity_id', o.id, ts));
    statements.push(restoreStmt(env.DB, 'opportunities', o.id));
  }

  // Restore contacts
  statements.push(restoreChildrenStmt(env.DB, 'contacts', 'account_id', accountId, ts));

  // Restore the account itself
  statements.push(restoreStmt(env.DB, 'accounts', accountId));
  statements.push(auditStmt(env.DB, {
    entityType: 'account',
    entityId: accountId,
    eventType: 'restored',
    user,
    summary: `Restored account "${account.name}"`,
  }));

  await batch(env.DB, statements);

  return redirectWithFlash(
    `/accounts/${accountId}`,
    `Restored account "${account.name}".`
  );
}
