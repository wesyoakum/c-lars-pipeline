// functions/sandbox/assistant/actions/[id]/move.js
//
// POST /sandbox/assistant/actions/:id/move?to=hot|plan|quick|skip
//
// Move one open claudia_actions row between quadrants. The ?to=
// query param is the new quadrant. Useful when Wes disagrees with
// Claudia's classification (a Plan that's actually Hot, a Quick
// that should really be Skipped, etc.). Writes a quadrant_changed
// audit row so the trail shows the move.
//
// Returns the refreshed actions panel for HTMX outerHTML swap.
// Wes-only.

import { one, run } from '../../../../lib/db.js';
import { now } from '../../../../lib/ids.js';
import { audit } from '../../../../lib/audit.js';
import {
  loadActionsAndQuestions,
  renderActionsPanel,
} from '../../../../lib/claudia-actions-render.js';

const SANDBOX_OWNER = 'wes.yoakum@c-lars.com';
const ALLOWED_QUADRANTS = new Set(['hot', 'plan', 'quick', 'skip']);

function htmlFragment(s) {
  return new Response(String(s), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

export async function onRequestPost(context) {
  const { env, data, params, request } = context;
  const user = data?.user;
  if (!user || user.email !== SANDBOX_OWNER) {
    return new Response('Not found', { status: 404 });
  }

  const actionId = params.id;
  const to = new URL(request.url).searchParams.get('to');
  if (!ALLOWED_QUADRANTS.has(to)) {
    return new Response('Bad request: unknown quadrant', { status: 400 });
  }

  const action = await one(
    env.DB,
    `SELECT id, status, quadrant, title FROM claudia_actions WHERE id = ? AND user_id = ?`,
    [actionId, user.id]
  );
  if (!action) return new Response('Not found', { status: 404 });

  if (action.status === 'open' && action.quadrant !== to) {
    const ts = now();
    const fromQ = action.quadrant;
    await run(
      env.DB,
      `UPDATE claudia_actions SET quadrant = ?, updated_at = ? WHERE id = ?`,
      [to, ts, actionId]
    );
    try {
      await audit(env.DB, {
        entityType: 'claudia_action',
        entityId: actionId,
        eventType: 'quadrant_changed',
        user,
        summary: `Moved ${fromQ} → ${to}: ${(action.title || '').slice(0, 200)}`,
        changes: { quadrant: { from: fromQ, to } },
      });
    } catch { /* non-fatal */ }
  }

  const { actions } = await loadActionsAndQuestions(env, user.id);
  return htmlFragment(renderActionsPanel(actions));
}
