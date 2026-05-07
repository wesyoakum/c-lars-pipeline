// functions/sandbox/assistant/questions/[id]/drop.js
//
// POST /sandbox/assistant/questions/:id/drop
//
// Marks one open claudia_questions row as dropped (Wes decided this
// question isn't relevant or has gone stale — distinct from
// "answered"). Returns the refreshed questions panel for HTMX
// outerHTML swap on #claudia-questions-panel. Wes-only.

import { one, run } from '../../../../lib/db.js';
import { now } from '../../../../lib/ids.js';
import { audit } from '../../../../lib/audit.js';
import {
  loadActionsAndQuestions,
  renderQuestionsPanel,
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

  const qid = params.id;
  const q = await one(
    env.DB,
    `SELECT id, status, question FROM claudia_questions WHERE id = ? AND user_id = ?`,
    [qid, user.id]
  );
  if (!q) return new Response('Not found', { status: 404 });

  if (q.status === 'open') {
    const ts = now();
    await run(
      env.DB,
      `UPDATE claudia_questions
          SET status = 'dropped',
              answered_at = ?,
              answered_by_user_id = ?,
              updated_at = ?
        WHERE id = ?`,
      [ts, user.id, ts, qid]
    );
    try {
      await audit(env.DB, {
        entityType: 'claudia_question',
        entityId: qid,
        eventType: 'dropped',
        user,
        summary: `Dropped: ${(q.question || '').slice(0, 200)}`,
      });
    } catch { /* non-fatal */ }
  }

  const { questions } = await loadActionsAndQuestions(env, user.id);
  return htmlFragment(renderQuestionsPanel(questions));
}
