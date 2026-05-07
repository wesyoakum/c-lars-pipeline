// functions/sandbox/assistant/questions/[id]/answer.js
//
// POST /sandbox/assistant/questions/:id/answer
//   form body { answer: "..." }
//
// Records Wes's answer to one open claudia_questions row, flips
// status='answered'. Returns the refreshed questions panel for HTMX
// outerHTML swap on #claudia-questions-panel. Wes-only.
//
// The answer value flows back into the next re-evaluation's
// context_json so future triage runs see the resolution. (Phase A
// re-eval is fired by fresh events; the answer doesn't itself trigger
// anything — it just becomes available context.)

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

async function formBody(request) {
  const ct = request.headers.get('content-type') || '';
  if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
    const fd = await request.formData();
    const out = {};
    for (const [k, v] of fd.entries()) out[k] = v;
    return out;
  }
  if (ct.includes('application/json')) {
    try { return await request.json(); } catch { return {}; }
  }
  return {};
}

export async function onRequestPost(context) {
  const { env, data, params, request } = context;
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

  const body = await formBody(request);
  const answer = String(body.answer || '').trim();

  if (q.status === 'open' && answer) {
    const ts = now();
    await run(
      env.DB,
      `UPDATE claudia_questions
          SET answer = ?,
              status = 'answered',
              answered_at = ?,
              answered_by_user_id = ?,
              updated_at = ?
        WHERE id = ?`,
      [answer, ts, user.id, ts, qid]
    );
    try {
      await audit(env.DB, {
        entityType: 'claudia_question',
        entityId: qid,
        eventType: 'answered',
        user,
        summary: `Answered: ${(q.question || '').slice(0, 200)}`,
      });
    } catch { /* non-fatal */ }
  }

  return await respond(env, user, request);
}

async function respond(env, user, request) {
  if (request.headers.get('HX-Request')) {
    const { questions } = await loadActionsAndQuestions(env, user.id);
    return htmlFragment(renderQuestionsPanel(questions));
  }
  const referer = request.headers.get('Referer') || '/sandbox/assistant';
  return new Response(null, { status: 303, headers: { Location: referer } });
}
