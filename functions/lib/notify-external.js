// functions/lib/notify-external.js
//
// External notification dispatcher (Phase 7).
//
// Distinct from lib/notify.js which writes to the in-app
// `notifications` table (the bell icon + toasts). This module
// dispatches to user-configured EXTERNAL channels — Microsoft Teams
// incoming webhooks (Phase 7b) and email via Resend (Phase 7c).
// The two are complementary: a single CRM event might fire both
// (e.g. a new task creates an in-app notification AND posts an
// Adaptive Card to the user's Teams channel).
//
// Single API:
//   await notifyExternal(env, {
//     userId,                 // who is the recipient
//     eventType,              // one of NOTIFICATION_EVENTS
//     data,                   // event-specific payload
//     context: { ref_type, ref_id },   // optional CRM context
//     idempotencyKey,         // optional — prevents duplicate sends
//   });
//
// The dispatcher:
//   1. Looks up the user's enabled channels for this event_type
//   2. For each channel, looks up the user's target (webhook URL / email)
//   3. Renders the per-channel template
//   4. Calls the channel's send() function (provider modules in 7b/7c)
//   5. Appends a row to notification_log
//
// Failures never throw to the caller — sending notifications is
// fire-and-forget from the CRM's perspective. Errors land in
// notification_log.status='failed' and the in-app flow continues.

import { all, one, run } from './db.js';
import { uuid, now } from './ids.js';

// Load provider modules so they self-register into PROVIDERS via
// registerNotificationProvider() at module-load time. Imports are
// after the registry definition (see end of file). The presence of
// the import alone is what triggers registration — we don't use any
// named exports from the provider modules here.
import './notify-providers/teams.js';
// Email provider (Phase 7c) lands here when wired:
// import './notify-providers/email.js';

// Canonical event type list. Add new events here AND default rows
// to user_notification_prefs (lazily, in the settings UI). Names
// are stable PKs on user_notification_prefs.
export const NOTIFICATION_EVENTS = Object.freeze({
  TASK_ASSIGNED:        'task_assigned',
  TASK_DUE_SOON:        'task_due_soon',
  MENTION:              'mention',
  OPP_STAGE_CHANGED:    'opp_stage_changed',
  QUOTE_STATUS_CHANGED: 'quote_status_changed',
  DAILY_DIGEST:         'daily_digest',
});

export const NOTIFICATION_EVENT_LABELS = Object.freeze({
  task_assigned:        'Task assigned to me',
  task_due_soon:        'Task due in the next 24 hours',
  mention:              '@mention in a note',
  opp_stage_changed:    'Opportunity stage changed (one I own)',
  quote_status_changed: 'Quote status changed (one I created)',
  daily_digest:         'Daily digest summary',
});

export const NOTIFICATION_CHANNELS = Object.freeze({
  TEAMS: 'teams',
  EMAIL: 'email',
});

export const NOTIFICATION_CHANNEL_LABELS = Object.freeze({
  teams: 'Teams',
  email: 'Email',
});

// --------------------------------------------------------------------

/**
 * Dispatch to external channels per the user's prefs. Returns
 * [{channel, status}] entries. Never throws.
 */
export async function notifyExternal(env, opts) {
  const userId = opts?.userId;
  const eventType = opts?.eventType;
  if (!userId || !eventType) {
    return [{ channel: null, status: 'skipped', error: 'missing_user_or_event' }];
  }

  const rows = await all(env.DB,
    `SELECT p.channel, c.id AS channel_id, c.target, c.active
       FROM user_notification_prefs p
  LEFT JOIN user_notification_channels c
         ON c.user_id = p.user_id AND c.channel = p.channel
      WHERE p.user_id = ? AND p.event_type = ? AND p.enabled = 1`,
    [userId, eventType]);

  if (!rows.length) {
    return [{ channel: null, status: 'skipped', reason: 'no_subscriptions' }];
  }

  const results = [];
  for (const r of rows) {
    if (!r.active || !r.target) {
      results.push({ channel: r.channel, status: 'skipped', reason: 'channel_inactive' });
      await logExternal(env, {
        user_id: userId, event_type: eventType, channel: r.channel,
        target: r.target, status: 'skipped',
        error_message: 'channel_inactive',
        idempotency_key: opts.idempotencyKey || null,
        ref_type: opts.context?.ref_type || null,
        ref_id: opts.context?.ref_id || null,
      });
      continue;
    }

    if (opts.idempotencyKey) {
      const dup = await one(env.DB,
        `SELECT id FROM notification_log
          WHERE idempotency_key = ? AND channel = ? AND status = 'sent'
          LIMIT 1`,
        [opts.idempotencyKey, r.channel]);
      if (dup) {
        results.push({ channel: r.channel, status: 'skipped', reason: 'duplicate' });
        continue;
      }
    }

    let result;
    try {
      const provider = PROVIDERS[r.channel];
      if (!provider) {
        result = { status: 'skipped', error: 'no_provider' };
      } else {
        result = await provider.send(env, {
          target: r.target,
          eventType,
          data: opts.data || {},
          context: opts.context || {},
        });
      }
    } catch (e) {
      result = { status: 'failed', error: e?.message || String(e) };
    }

    await logExternal(env, {
      user_id: userId, event_type: eventType, channel: r.channel,
      target: r.target, status: result.status,
      error_message: result.error || null,
      idempotency_key: opts.idempotencyKey || null,
      payload_preview: result.payload_preview || null,
      ref_type: opts.context?.ref_type || null,
      ref_id: opts.context?.ref_id || null,
    });

    results.push({ channel: r.channel, status: result.status, error: result.error });
  }

  return results;
}

/**
 * Send a one-off "test" notification. Bypasses the prefs lookup —
 * the user is testing the channel, not an event subscription.
 */
export async function sendTestNotification(env, channel, target) {
  const provider = PROVIDERS[channel];
  if (!provider) return { ok: false, error: 'no_provider' };
  try {
    const result = await provider.send(env, {
      target,
      eventType: 'test',
      data: { message: 'Test notification from C-LARS PMS — your channel is wired up.' },
      context: {},
    });
    return { ok: result.status === 'sent', error: result.error || null };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// --------------------------------------------------------------------
// Provider registry — populated by Phase 7b (Teams) / 7c (email).

const PROVIDERS = {};

export function registerNotificationProvider(channel, provider) {
  PROVIDERS[channel] = provider;
}

export function hasProvider(channel) {
  return !!PROVIDERS[channel];
}

// --------------------------------------------------------------------

async function logExternal(env, row) {
  try {
    await run(env.DB,
      `INSERT INTO notification_log
         (id, user_id, event_type, channel, target, status,
          error_message, idempotency_key, payload_preview,
          ref_type, ref_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuid(), row.user_id, row.event_type, row.channel,
        row.target || null, row.status, row.error_message || null,
        row.idempotency_key || null,
        row.payload_preview ? String(row.payload_preview).slice(0, 4000) : null,
        row.ref_type || null, row.ref_id || null,
        now(),
      ]);
  } catch (e) {
    /* eslint-disable-next-line no-console */
    if (typeof console !== 'undefined') console.warn('notification_log insert failed:', e?.message);
  }
}
