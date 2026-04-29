// functions/api/cron/notifications.js
//
// POST /api/cron/notifications — fired by the sidecar cron Worker
// every 5 minutes. Walks the activities table for tasks whose
// reminder time has just hit and fires task_reminder_fired
// notifications through whichever channels each user has enabled.
//
// Phase 7d (initial). Future iterations of this endpoint can host
// the daily-digest tick and any other "scan and notify" sweeps.
//
// Lookback window: 24 hours. We fire reminders whose remind_at is
// in the past but no older than 24h. Older reminders are
// considered stale (cron offline / user backdated something) and
// skipped silently.
//
// Idempotency: notifyExternal() uses idempotency_key
// 'task_reminder:<task_id>' — once a reminder has been logged as
// 'sent' on a channel, subsequent ticks skip it. Means even if
// we run every 5 minutes, each reminder fires exactly once.
//
// Authentication: same x-cron-secret pattern as /api/cron/sweep.

import { all } from '../../lib/db.js';
import { notifyExternal, NOTIFICATION_EVENTS } from '../../lib/notify-external.js';

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

const LOOKBACK_HOURS = 24;

export async function onRequestPost(context) {
  const { env, request } = context;

  if (!checkSecret(request, env)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const lookbackIso = new Date(now - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

  // Find tasks with a reminder due. Joins to the user table for the
  // assignee + accounts/opportunities for the link label so the
  // notification card can render context. Activities table doesn't
  // have a "reminder fired" column — idempotency is enforced via
  // notification_log (idempotency_key on send).
  const due = await all(env.DB,
    `SELECT a.id, a.subject, a.body, a.remind_at, a.due_at,
            a.assigned_user_id, a.opportunity_id, a.account_id, a.quote_id,
            o.number AS opp_number, o.title AS opp_title,
            ac.name AS account_name, ac.alias AS account_alias,
            q.number AS quote_number, q.title AS quote_title
       FROM activities a
       LEFT JOIN opportunities o ON o.id = a.opportunity_id
       LEFT JOIN accounts ac     ON ac.id = a.account_id
       LEFT JOIN quotes q        ON q.id = a.quote_id
      WHERE a.type = 'task'
        AND a.status = 'pending'
        AND a.remind_at IS NOT NULL
        AND a.remind_at <= ?
        AND a.remind_at > ?
        AND a.assigned_user_id IS NOT NULL
      ORDER BY a.remind_at ASC
      LIMIT 200`,
    [nowIso, lookbackIso]);

  const summary = { ok: true, checked: due.length, fired: 0, skipped: 0, failed: 0 };

  for (const t of due) {
    const linkLabel = t.opp_number
      ? `${t.opp_number} · ${t.opp_title || ''}`.trim()
      : t.account_alias || t.account_name
        || (t.quote_number ? `${t.quote_number} · ${t.quote_title || ''}`.trim() : '');
    const link = t.opportunity_id
      ? `/opportunities/${t.opportunity_id}`
      : t.account_id
        ? `/accounts/${t.account_id}`
        : '/activities';

    const results = await notifyExternal(env, {
      userId: t.assigned_user_id,
      eventType: NOTIFICATION_EVENTS.TASK_REMINDER_FIRED,
      data: {
        task: {
          subject: t.subject,
          body: t.body || t.subject,
          due_at: t.due_at,
          link_label: linkLabel,
        },
        link,
      },
      context: t.opportunity_id
        ? { ref_type: 'opportunity', ref_id: t.opportunity_id }
        : t.account_id
          ? { ref_type: 'account', ref_id: t.account_id }
          : null,
      idempotencyKey: 'task_reminder:' + t.id,
    });

    // Roll up: any 'sent' counts as fired, all-skipped counts as skipped,
    // any failed bumps failed.
    const sent = results.filter((r) => r.status === 'sent').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    if (sent > 0) summary.fired++;
    else if (failed > 0) summary.failed++;
    else summary.skipped++;
  }

  return jsonResponse(summary);
}
