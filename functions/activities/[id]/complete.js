// functions/activities/[id]/complete.js
//
// POST /activities/:id/complete — Mark an activity as completed.
// Also fires task.completed for the auto-tasks engine and advances the
// opportunity stage when the completed task was an auto-created
// "Submit quote to customer" task (see stage-transitions.js).

import { one, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { now } from '../../lib/ids.js';
import { redirectWithFlash } from '../../lib/http.js';
import { fireEvent } from '../../lib/auto-tasks.js';
import { advanceStageOnTaskComplete } from '../../lib/stage-transitions.js';

export async function onRequestPost(context) {
  const { env, data, params, request } = context;
  const user = data?.user;
  const actId = params.id;

  const act = await one(env.DB, 'SELECT * FROM activities WHERE id = ?', [actId]);
  if (!act) return new Response('Not found', { status: 404 });

  const alreadyCompleted = act.status === 'completed';
  const ts = now();

  await batch(env.DB, [
    stmt(env.DB,
      `UPDATE activities SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`,
      [ts, ts, actId]),
    auditStmt(env.DB, {
      entityType: 'activity',
      entityId: actId,
      eventType: 'completed',
      user,
      summary: `Completed ${act.type}: ${act.subject}`,
    }),
  ]);

  // Only run the completion side effects when this is the edge
  // (pending/cancelled → completed), never on a repeat press.
  if (!alreadyCompleted && act.type === 'task') {
    try {
      await advanceStageOnTaskComplete(context, act);
    } catch (err) {
      console.error('advanceStageOnTaskComplete failed:', err?.message || err);
    }

    try {
      const opp = act.opportunity_id
        ? await one(env.DB, 'SELECT * FROM opportunities WHERE id = ?', [act.opportunity_id])
        : null;
      const account = opp?.account_id
        ? await one(env.DB, 'SELECT * FROM accounts WHERE id = ?', [opp.account_id])
        : null;
      fireEvent(env, 'task.completed', {
        trigger: { user, at: ts },
        task: { ...act, status: 'completed', completed_at: ts },
        opportunity: opp,
        account,
      }, user).catch((err) =>
        console.error('fireEvent(task.completed) failed:', err?.message || err)
      );
    } catch (err) {
      console.error('task.completed payload build failed:', err?.message || err);
    }
  }

  // Redirect back to referrer if available, otherwise activities list
  const referer = request.headers.get('referer');
  if (referer) {
    try {
      const refUrl = new URL(referer);
      return redirectWithFlash(refUrl.pathname, `Completed: ${act.subject}`);
    } catch {}
  }

  return redirectWithFlash('/activities', `Completed: ${act.subject}`);
}
