// functions/settings/claudia/audit/[id]/undo.js
//
// POST /settings/claudia/audit/:id/undo — fire claudiaUndo() for a
// single audit row from the audit dashboard. Returns the freshly-
// rendered row HTML so HTMX outerHTML-swaps it in place. Wes-only.

import { one } from '../../../../lib/db.js';
import { claudiaUndo } from '../../../../lib/claudia-writes.js';
import { renderClaudiaAuditRow } from '../../../../lib/claudia-audit-render.js';

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  if (!user || user.email !== SANDBOX_OWNER) {
    return new Response('Not found', { status: 404 });
  }

  const auditId = String(params?.id || '').trim();
  if (!auditId) return new Response('Missing id', { status: 400 });

  // claudiaUndo enforces ownership (user_id match) and the 24h window
  // internally; a non-{ ok: true } result means it bailed for one of
  // those reasons. Either way we re-render the row so the user sees
  // the new state (errors render as a normal "expired"/"already undone"
  // status; we don't need to surface a separate flash).
  await claudiaUndo(env, user, auditId, { reason: 'manual undo from audit dashboard' });

  // Re-fetch with the same shape the dashboard query uses so the
  // re-rendered row matches.
  const fresh = await one(
    env.DB,
    `SELECT id, action, ref_table, ref_id, batch_id, summary,
            created_at, undone_at, undo_reason
       FROM claudia_writes
      WHERE id = ? AND user_id = ?`,
    [auditId, user.id]
  );
  if (!fresh) {
    // Should be impossible (we just queried it via undo) but bail safely.
    return new Response('', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  // Resolve the entity's display label so the swapped row matches the
  // page renderer. Single-row lookup so no batching needed.
  const label = await loadOneLabel(env, fresh.ref_table, fresh.ref_id);

  return new Response(String(renderClaudiaAuditRow(fresh, label)), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

async function loadOneLabel(env, table, id) {
  if (!id) return null;
  switch (table) {
    case 'accounts': {
      const r = await one(env.DB, 'SELECT name FROM accounts WHERE id = ?', [id]);
      return r?.name || null;
    }
    case 'contacts': {
      const r = await one(env.DB, 'SELECT first_name, last_name, email FROM contacts WHERE id = ?', [id]);
      if (!r) return null;
      const name = `${r.first_name || ''} ${r.last_name || ''}`.trim();
      return name || r.email || null;
    }
    case 'activities': {
      const r = await one(env.DB, 'SELECT subject, type FROM activities WHERE id = ?', [id]);
      return r?.subject || null;
    }
    case 'opportunities': {
      const r = await one(env.DB, 'SELECT number, title FROM opportunities WHERE id = ?', [id]);
      if (!r) return null;
      return `${r.number || ''} ${r.title || ''}`.trim() || null;
    }
    case 'quotes': {
      const r = await one(env.DB, 'SELECT number FROM quotes WHERE id = ?', [id]);
      return r?.number || null;
    }
    case 'jobs': {
      const r = await one(env.DB, 'SELECT number FROM jobs WHERE id = ?', [id]);
      return r?.number || null;
    }
    default:
      return null;
  }
}
