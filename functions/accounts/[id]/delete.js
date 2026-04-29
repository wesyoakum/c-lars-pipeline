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

function wantsJson(request) {
  const a = request.headers.get('accept') || '';
  return a.includes('application/json') && !a.includes('text/html');
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const accountId = params.id;
  const json = wantsJson(request);
  const url = new URL(request.url);
  // Cascade flag: also delete this account's opportunities (and their
  // jobs, quotes, cost_builds, activities, documents). Without it
  // the delete refuses with 409 + a child-count summary so the
  // cascade-delete modal can warn the user.
  const cascade = url.searchParams.get('cascade') === '1';

  const account = await one(
    env.DB,
    `SELECT id, name FROM accounts WHERE id = ?`,
    [accountId]
  );
  if (!account) {
    if (json) return jsonResponse({ ok: false, error: 'Account not found' }, 404);
    return htmlResponse(
      layout(
        'Not found',
        `<section class="card"><h1>Account not found</h1><p><a href="/accounts">Back</a></p></section>`,
        { user, env: data?.env, activeNav: '/accounts' }
      ),
      { status: 404 }
    );
  }

  const opps = await all(
    env.DB,
    `SELECT id, number, title FROM opportunities WHERE account_id = ?`,
    [accountId]
  );
  if (opps.length > 0 && !cascade) {
    const msg = `Cannot delete: ${opps.length} opportunit${opps.length === 1 ? 'y' : 'ies'} reference this account. Use cascade=1 to delete them too.`;
    if (json) return jsonResponse({ ok: false, error: msg, opportunity_count: opps.length }, 409);
    return redirectWithFlash(`/accounts/${accountId}`, msg, 'error');
  }

  const contacts = await all(
    env.DB,
    `SELECT id, first_name, last_name FROM contacts WHERE account_id = ?`,
    [accountId]
  );

  // Cascade case: load all jobs under this account's opps so we can
  // delete them explicitly (opp→job FK is RESTRICT, doesn't cascade).
  // Quotes, cost_builds, activities, documents all CASCADE via FK
  // when their parent opp / job goes away — no manual delete needed.
  const jobs = cascade && opps.length > 0
    ? await all(env.DB,
        `SELECT j.id, j.number, j.title FROM jobs j
           JOIN opportunities o ON o.id = j.opportunity_id
          WHERE o.account_id = ?`,
        [accountId])
    : [];

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
  if (cascade) {
    for (const j of jobs) {
      statements.push(auditStmt(env.DB, {
        entityType: 'job',
        entityId: j.id,
        eventType: 'deleted',
        user,
        summary: `Job "${j.number || ''} · ${j.title || ''}" removed (parent account cascade-deleted)`,
      }));
    }
    for (const o of opps) {
      statements.push(auditStmt(env.DB, {
        entityType: 'opportunity',
        entityId: o.id,
        eventType: 'deleted',
        user,
        summary: `Opportunity "${o.number || ''} · ${o.title || ''}" removed (parent account cascade-deleted)`,
      }));
    }
    // Delete jobs first (FK RESTRICT on opp→job), then opps (FK
    // RESTRICT on account→opp), then the account (cascades the
    // remaining children automatically).
    for (const j of jobs) {
      statements.push(stmt(env.DB, `DELETE FROM jobs WHERE id = ?`, [j.id]));
    }
    for (const o of opps) {
      statements.push(stmt(env.DB, `DELETE FROM opportunities WHERE id = ?`, [o.id]));
    }
  }
  statements.push(
    auditStmt(env.DB, {
      entityType: 'account',
      entityId: accountId,
      eventType: 'deleted',
      user,
      summary: cascade && opps.length > 0
        ? `Deleted account "${account.name}" (cascade: ${opps.length} opp(s), ${jobs.length} job(s))`
        : `Deleted account "${account.name}"`,
    })
  );
  statements.push(
    stmt(env.DB, `DELETE FROM accounts WHERE id = ?`, [accountId])
  );

  await batch(env.DB, statements);

  if (json) return jsonResponse({ ok: true, id: accountId });
  return redirectWithFlash(`/accounts`, `Deleted account "${account.name}".`);
}
