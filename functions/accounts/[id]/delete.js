// functions/accounts/[id]/delete.js
//
// POST /accounts/:id/delete — delete an account.
//
// Contacts cascade via FK (ON DELETE CASCADE). We write:
//   - one `deleted` audit event for the account itself
//   - one `deleted` audit event per contact being removed
// so the activity history survives the cascade.
//
// In P0 we don't stop deletion if opportunities reference the account —
// the FK is set up with ON DELETE CASCADE on opportunities-accounts? Let me
// double check: no, opportunities references accounts WITHOUT cascade, so
// trying to delete an account that has opportunities will fail at the DB
// level. That's correct behavior; we just surface the error cleanly.

import { one, all, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { layout, htmlResponse } from '../../lib/layout.js';
import { redirectWithFlash } from '../../lib/http.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  const accountId = params.id;

  const account = await one(
    env.DB,
    `SELECT id, name FROM accounts WHERE id = ?`,
    [accountId]
  );
  if (!account) {
    return htmlResponse(
      layout(
        'Not found',
        `<section class="card"><h1>Account not found</h1><p><a href="/accounts">Back</a></p></section>`,
        { user, env: data?.env, activeNav: '/accounts' }
      ),
      { status: 404 }
    );
  }

  // Refuse if any opportunities are tied to this account — P0 keeps the
  // commercial history immutable rather than cascading.
  const oppCount = await one(
    env.DB,
    `SELECT COUNT(*) AS n FROM opportunities WHERE account_id = ?`,
    [accountId]
  );
  if (oppCount?.n > 0) {
    return redirectWithFlash(
      `/accounts/${accountId}`,
      `Cannot delete: ${oppCount.n} opportunit${oppCount.n === 1 ? 'y' : 'ies'} reference this account.`,
      'error'
    );
  }

  const contacts = await all(
    env.DB,
    `SELECT id, first_name, last_name FROM contacts WHERE account_id = ?`,
    [accountId]
  );

  // Write audits BEFORE the delete so FK cascades don't orphan them
  // (audit_events has no FK back to the entities — deliberate).
  const statements = [];
  for (const c of contacts) {
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || '(no name)';
    statements.push(
      auditStmt(env.DB, {
        entityType: 'contact',
        entityId: c.id,
        eventType: 'deleted',
        user,
        summary: `Contact "${name}" removed (parent account deleted)`,
      })
    );
  }
  statements.push(
    auditStmt(env.DB, {
      entityType: 'account',
      entityId: accountId,
      eventType: 'deleted',
      user,
      summary: `Deleted account "${account.name}"`,
    })
  );
  statements.push(
    stmt(env.DB, `DELETE FROM accounts WHERE id = ?`, [accountId])
  );

  await batch(env.DB, statements);

  return redirectWithFlash(`/accounts`, `Deleted account "${account.name}".`);
}
