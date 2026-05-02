// functions/api/cron/claudia-tick.js
//
// POST /api/cron/claudia-tick — fired hourly by the sidecar cron
// Worker. For each user that has a non-empty event queue or hasn't
// gotten a fresh observation in over an hour, ask Claude to look at
// the recent state and write 0–3 short observations to
// claudia_observations. The observations show up at the top of
// /sandbox/assistant on the user's next visit.
//
// Self-throttling: if there are no pending events AND the last
// observation is < 55 min old, the tick is a no-op for that user.
// Means a fixed hourly cadence never spams Claude when nothing has
// changed.
//
// Sandbox scope: only fires for the assistant owner (Wes). Reusing
// the cron worker's existing x-cron-secret auth.
//
// Model: this is the one place where we run Claude Opus by default
// instead of the chat's Sonnet. The tick is a single one-shot
// (no tool-use loop), runs on a hard once-an-hour cadence, and
// produces 0-3 observations Wes will skim — exactly the kind of
// "fewer calls, better reasoning per call" workload Opus is right
// for. Cost is bounded (~24 calls/day at the floor, less when the
// tick self-throttles to "quiet"). Override via env.CLAUDIA_TICK_MODEL
// if you want to A/B against Sonnet.

import { all, one, run } from '../../lib/db.js';
import { now, uuid } from '../../lib/ids.js';
import { messagesJson } from '../../lib/anthropic.js';
import { CLAUDIA_USER_ID } from '../../lib/auth.js';
import { regenerateBrief } from '../../lib/claudia-brief.js';

const SANDBOX_OWNER_EMAIL = 'wes.yoakum@c-lars.com';
const STALE_OBSERVATION_MINUTES = 55;
const MAX_EVENTS_PER_TICK = 50;
const CLAUDIA_TICK_MODEL_DEFAULT = 'claude-opus-4-7';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function checkSecret(request, env) {
  const provided = request.headers.get('x-cron-secret') || '';
  const expected = env.CRON_SECRET || '';
  if (!expected) return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!checkSecret(request, env)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const user = await one(
    env.DB,
    'SELECT id, email, display_name, role FROM users WHERE email = ? LIMIT 1',
    [SANDBOX_OWNER_EMAIL]
  );
  if (!user) {
    return jsonResponse({ ok: true, skipped: 'owner_not_found' });
  }

  const lastObs = await one(
    env.DB,
    'SELECT created_at FROM claudia_observations WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
    [user.id]
  );

  const events = await all(
    env.DB,
    `SELECT id, type, ref_id, summary, created_at
       FROM claudia_events_pending
      WHERE user_id = ? AND processed_at IS NULL
      ORDER BY created_at ASC
      LIMIT ?`,
    [user.id, MAX_EVENTS_PER_TICK]
  );

  const minutesSinceLastObs = lastObs
    ? (Date.now() - Date.parse(lastObs.created_at)) / 60000
    : Infinity;

  if (events.length === 0 && minutesSinceLastObs < STALE_OBSERVATION_MINUTES) {
    return jsonResponse({
      ok: true,
      skipped: 'quiet',
      minutes_since_last_observation: Math.round(minutesSinceLastObs),
    });
  }

  // Pre-fetch context Claude considers when generating the observation.
  // We pass it inline (one-shot, no tool use) so the cron tick is fast
  // and predictable.
  const openOpps = await all(
    env.DB,
    `SELECT id, number, title, stage, expected_close_date,
            estimated_value_usd, updated_at, stage_entered_at
       FROM opportunities
      WHERE (owner_user_id = ? OR salesperson_user_id = ?)
        AND stage NOT IN ('won', 'lost', 'closed')
      ORDER BY updated_at DESC
      LIMIT 30`,
    [user.id, user.id]
  );

  const openTasks = await all(
    env.DB,
    `SELECT id, subject, status, due_at, opportunity_id, account_id, updated_at, created_at
       FROM activities
      WHERE assigned_user_id = ?
        AND completed_at IS NULL
        AND (type = 'task' OR type IS NULL)
      ORDER BY due_at IS NULL, due_at ASC
      LIMIT 50`,
    [user.id]
  );

  const recentObservations = await all(
    env.DB,
    `SELECT body, created_at
       FROM claudia_observations
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 5`,
    [user.id]
  );

  // Tasks people have assigned TO Claudia herself. She doesn't act on
  // them yet (write surface for activities is still gated) — the
  // hourly tick just surfaces them so Wes (and the assigner) sees
  // that she received the request and what she'd suggest doing.
  const myAssignedTasks = await all(
    env.DB,
    `SELECT a.id, a.subject, a.body, a.status, a.due_at, a.opportunity_id,
            a.account_id, a.created_at, a.updated_at, a.created_by_user_id,
            assignor.display_name AS assigned_by_name,
            assignor.email AS assigned_by_email,
            acct.name AS account_name,
            opp.number AS opp_number, opp.title AS opp_title
       FROM activities a
       LEFT JOIN users assignor ON assignor.id = a.created_by_user_id
       LEFT JOIN accounts acct ON acct.id = a.account_id
       LEFT JOIN opportunities opp ON opp.id = a.opportunity_id
      WHERE a.assigned_user_id = ?
        AND a.completed_at IS NULL
        AND (a.type = 'task' OR a.type IS NULL)
      ORDER BY a.due_at IS NULL, a.due_at ASC, a.created_at DESC
      LIMIT 25`,
    [CLAUDIA_USER_ID]
  );

  const today = new Date().toISOString().slice(0, 10);
  const display = user.display_name || user.email;

  const system = [
    `You are Claudia generating a periodic observations feed for ${display}. Today is ${today}. You are NOT in a chat — you are running on a server-side hourly cron tick. Your job is to scan the state below and produce 0–3 short, high-signal observations that ${display} will see at the top of his assistant tab next time he opens it.`,
    '',
    'WHAT MAKES A GOOD OBSERVATION:',
    '- Specific. Cite the exact opp number/title/task subject and a date.',
    '- Actionable. There should be an implied next move, not a status report.',
    '- Net new. Do not repeat what you already said in recent observations (provided below).',
    '- Calibrated to the data you actually have. No speculation. No filler.',
    '',
    'GOOD examples:',
    '- "Opp WFM02-25314 (LARS for IWOCS Inquiry) hasn\'t moved in 12 days — was at quote_under_revision. Worth a check-in."',
    '- "Task \'Submit OC OC-RESPIN-001\' is past due and tied to Test Customer Inc."',
    '- "Two duplicate Notify Finance tasks for opp 99999 — one should be cleaned up."',
    '',
    'BAD examples (do not produce these):',
    '- "Things are looking quiet today." (no signal)',
    '- "Consider reviewing your funnel." (vague)',
    '- "Hi Wes! Hope your morning is going well!" (filler)',
    '',
    'TASKS ASSIGNED TO YOU (CLAUDIA):',
    'The state blob includes a `tasks_assigned_to_claudia` array — these are activities other users have assigned to YOUR user record (claudia-ai). For each unprocessed one, surface a single observation that:',
    '  - Names the assigner ("Kat assigned you ...") and the task subject.',
    '  - Cites the linked account/opp if any.',
    '  - States what you understand the ask to be (one sentence).',
    '  - Says what you would do — and that you need ' + display + ' to confirm before you do it (you don\'t have a write surface for activities yet, so even when permitted you can\'t mark the task complete on your own).',
    'Skip a task only if you already wrote an observation about it (check recent_observations). One observation per task; do not batch them.',
    '',
    'OUTPUT: strict JSON, no prose around it, no markdown fences. Shape:',
    '{ "observations": ["...one observation per string, markdown ok inside, 1-3 sentences..."] }',
    'If nothing is genuinely worth flagging, output { "observations": [] } and we will skip writing anything. Do not invent something to fill the slot.',
  ].join('\n');

  const stateBlob = JSON.stringify(
    {
      pending_events_since_last_tick: events,
      open_opportunities: openOpps,
      open_tasks: openTasks,
      tasks_assigned_to_claudia: myAssignedTasks,
      recent_observations: recentObservations,
      minutes_since_last_observation: Number.isFinite(minutesSinceLastObs)
        ? Math.round(minutesSinceLastObs)
        : null,
    },
    null,
    2
  );

  let observations = [];
  let modelError = null;
  try {
    const result = await messagesJson(env, {
      system,
      user: stateBlob,
      model: env.CLAUDIA_TICK_MODEL || CLAUDIA_TICK_MODEL_DEFAULT,
      cacheSystem: true,
      maxTokens: 1500,
      temperature: 0.3,
    });
    if (Array.isArray(result.json?.observations)) {
      observations = result.json.observations
        .map((s) => String(s || '').trim())
        .filter((s) => s.length > 0);
    }
  } catch (err) {
    modelError = err?.message || String(err);
    console.error('[claudia-tick] model call failed:', modelError);
  }

  // Persist observations (one row each).
  const ts = now();
  for (const body of observations) {
    await run(
      env.DB,
      `INSERT INTO claudia_observations (id, user_id, body, source_kind, created_at)
       VALUES (?, ?, ?, 'hourly_tick', ?)`,
      [uuid(), user.id, body, ts]
    );
  }

  // Mark pending events processed regardless of whether any observation
  // was written — they're consumed either way.
  if (events.length > 0) {
    const eventIds = events.map((e) => e.id);
    const placeholders = eventIds.map(() => '?').join(',');
    await run(
      env.DB,
      `UPDATE claudia_events_pending SET processed_at = ?
        WHERE id IN (${placeholders})`,
      [ts, ...eventIds]
    );
  }

  // Regenerate the "catch me up" brief alongside observations. Cheap
  // (Haiku, ~700 tokens out, ~7c/day at hourly cadence). Failures here
  // are swallowed so a brief outage doesn't break the rest of the
  // tick — read_brief will just surface a slightly stale snapshot.
  let briefError = null;
  try {
    await regenerateBrief(env, user, { sourceEvent: 'cron_tick' });
  } catch (err) {
    briefError = err?.message || String(err);
    console.error('[claudia-tick] brief regen failed:', briefError);
  }

  return jsonResponse({
    ok: true,
    user_id: user.id,
    pending_events_processed: events.length,
    observations_written: observations.length,
    model_error: modelError,
    brief_error: briefError,
  });
}
