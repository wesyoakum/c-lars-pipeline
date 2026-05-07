// functions/sandbox/assistant/actions/[id]/done.js
//
// POST /sandbox/assistant/actions/:id/done
//
// Marks one open claudia_actions row as completed by Wes (no Pipeline
// write; this is the manual-complete path used for Wes-life todos
// and for actions whose proposed_action_json is null). Returns the
// refreshed actions panel for HTMX outerHTML swap on
// #claudia-actions-panel. Wes-only.

import { one, run } from '../../../../lib/db.js';
import { now } from '../../../../lib/ids.js';
import { audit } from '../../../../lib/audit.js';
import {
  loadActionsAndQuestions,
  renderActionsPanel,
} from '../../../../lib/claudia-actions-render.js';

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';

function htmlFragment(s) {
  return new Response(String(s), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;
  if (!user || user.email !== SANDBOX_OWNER) {
    return new Response('Not found', { status: 404 });
  }

  const actionId = params.id;
  const action = await one(
    env.DB,
    `SELECT id, status, title FROM claudia_actions WHERE id = ? AND user_id = ?`,
    [actionId, user.id]
  );
  if (!action) return new Response('Not found', { status: 404 });

  if (action.status === 'open') {
    const ts = now();
    await run(
      env.DB,
      `UPDATE claudia_actions
          SET status = 'completed',
              completed_at = ?,
              completed_reason = 'manual_complete',
              decided_at = ?,
              decided_by_user_id = ?,
              updated_at = ?
        WHERE id = ?`,
      [ts, ts, user.id, ts, actionId]
    );
    try {
      await audit(env.DB, {
        entityType: 'claudia_action',
        entityId: actionId,
        eventType: 'completed',
        user,
        summary: `Manually marked done: ${(action.title || '').slice(0, 200)}`,
      });
    } catch { /* non-fatal */ }
  }

  return await respond(env, user, context.request);
}

// HTMX requests get a panel-fragment swap; plain form POSTs (e.g.
// from the per-file drill-down page) get a 303 redirect to the
// Referer so the browser lands back on a fully-rendered page with
// fresh state.
async function respond(env, user, request) {
  if (request.headers.get('HX-Request')) {
    const { actions } = await loadActionsAndQuestions(env, user.id);
    return htmlFragment(renderActionsPanel(actions));
  }
  const referer = request.headers.get('Referer') || '/sandbox/assistant';
  return new Response(null, { status: 303, headers: { Location: referer } });
}
