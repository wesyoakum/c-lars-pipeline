// functions/settings/notifications/sample.js
//
// POST /settings/notifications/sample — fire a sample notification
// for the given event type, using realistic placeholder data so the
// user can see what each card / email will actually look like before
// they wait for the real event to occur.
//
// Body: event_type=<one of NOTIFICATION_EVENTS>
//
// Sends through the user's enabled channels for that event (per the
// matrix). If they haven't checked any channels for the event yet,
// returns a flash error explaining what to check.

import { all } from '../../lib/db.js';
import { redirectWithFlash, formBody } from '../../lib/http.js';
import { notifyExternal, NOTIFICATION_EVENTS, NOTIFICATION_EVENT_LABELS } from '../../lib/notify-external.js';
import { saveNotificationPrefs } from './prefs.js';

const VALID_EVENTS = new Set(Object.values(NOTIFICATION_EVENTS));

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user) return redirectWithFlash('/settings/notifications', 'Sign in required.', 'error');

  const input = await formBody(request);
  const eventType = String(input.event_type || '').trim();
  if (!VALID_EVENTS.has(eventType)) {
    return redirectWithFlash('/settings/notifications', 'Invalid event type.', 'error');
  }

  // The "Send sample" button submits the same form as "Save changes",
  // so the form payload includes whatever boxes the user has just
  // checked. Persist the matrix BEFORE dispatching the sample so the
  // dispatcher's prefs lookup sees the freshly-checked rows. Without
  // this, the user has to click Save → Send sample as two steps,
  // which is the trap that hit them on first try.
  const saveResult = await saveNotificationPrefs(env, user, input);
  if (!saveResult.ok) {
    return redirectWithFlash('/settings/notifications', saveResult.error || 'Save failed.', 'error');
  }

  // Confirm at least one channel is enabled for this event so we can
  // tell the user "you need to check a box first" rather than
  // silently skipping.
  const enabledRows = await all(env.DB,
    `SELECT channel FROM user_notification_prefs
      WHERE user_id = ? AND event_type = ? AND enabled = 1`,
    [user.id, eventType]);
  if (enabledRows.length === 0) {
    return redirectWithFlash('/settings/notifications',
      `Check at least one channel for "${NOTIFICATION_EVENT_LABELS[eventType] || eventType}" first, then click Send sample.`,
      'error');
  }

  const sample = sampleDataFor(eventType, user);
  const results = await notifyExternal(env, {
    userId: user.id,
    eventType,
    data: sample.data,
    context: sample.context,
    // No idempotency key — samples should be repeatable.
  });

  // Summarize the results into a flash. Skipped/failed rows surface
  // with their reason so the user can debug.
  const sent = results.filter((r) => r.status === 'sent');
  const failed = results.filter((r) => r.status === 'failed');
  if (sent.length > 0 && failed.length === 0) {
    const channels = sent.map((r) => r.channel).join(', ');
    return redirectWithFlash('/settings/notifications',
      `Sample sent via ${channels}. Check your channel.`);
  }
  if (failed.length > 0) {
    const summary = failed.map((r) => `${r.channel}: ${r.error || 'failed'}`).join('; ');
    return redirectWithFlash('/settings/notifications',
      `Sample had failures — ${summary}`, 'error');
  }
  // No sends, no failures = all skipped (e.g., channel inactive, or
  // matrix had a stray pref with no channel target).
  return redirectWithFlash('/settings/notifications',
    'Sample dispatched but all channels were skipped — check that your Teams/email targets are configured.',
    'error');
}

/**
 * Reasonable placeholder data for each event type so the rendered
 * card / email looks like the real thing. The fields here mirror
 * what the actual call sites populate.
 */
function sampleDataFor(eventType, user) {
  const link = '/activities';
  const userName = user.display_name || user.email || 'You';

  switch (eventType) {
    case NOTIFICATION_EVENTS.TASK_ASSIGNED:
      return {
        data: {
          task: {
            body: '[SAMPLE] Send the spares quote to John at Trendsetter',
            due_at: tomorrow(),
            link_label: '12345 · Spares for pump skid',
          },
          assignedBy: { display_name: 'Jane Manager' },
          link: '/activities',
        },
        context: { ref_type: 'opportunity', ref_id: 'sample-opp-id' },
      };

    case NOTIFICATION_EVENTS.TASK_REMINDER_FIRED:
      return {
        data: {
          task: {
            subject: '[SAMPLE] Send the spares quote to John at Trendsetter',
            body: '[SAMPLE] Send the spares quote to John at Trendsetter — he asked for it by EOD Friday and we said we\'d include the optional refurb add-on.',
            due_at: tomorrow(),
            link_label: '12345 · Spares for pump skid',
          },
          link: '/activities',
        },
        context: { ref_type: 'opportunity', ref_id: 'sample-opp-id' },
      };

    case NOTIFICATION_EVENTS.TASK_DUE_SOON:
      return {
        data: {
          task: {
            body: '[SAMPLE] Loop in engineering on the integration question',
            due_at: tomorrow(),
          },
          link: '/activities',
        },
        context: {},
      };

    case NOTIFICATION_EVENTS.MENTION:
      return {
        data: {
          actor: { display_name: 'Jane Manager' },
          note: '[SAMPLE] Hey @' + userName + ', can you take a look at the latest revision before EOD?',
          context_label: 'Opportunity 12345 · Spares for pump skid',
          link: '/opportunities/sample-opp-id',
        },
        context: { ref_type: 'opportunity', ref_id: 'sample-opp-id' },
      };

    case NOTIFICATION_EVENTS.OPP_STAGE_CHANGED:
      return {
        data: {
          opp_label: '[SAMPLE] 12345 · Spares for pump skid',
          new_stage: 'Quote sent',
          previous_stage: 'Lead',
          actor: 'Jane Manager',
          link: '/opportunities/sample-opp-id',
        },
        context: { ref_type: 'opportunity', ref_id: 'sample-opp-id' },
      };

    case NOTIFICATION_EVENTS.QUOTE_STATUS_CHANGED:
      return {
        data: {
          quote_number: 'Q12345-1',
          quote_label: '[SAMPLE] Quote for 4 spare valves',
          new_status: 'Issued',
          previous_status: 'Draft',
          link: '/opportunities/sample-opp-id/quotes/sample-quote-id',
        },
        context: { ref_type: 'quote', ref_id: 'sample-quote-id' },
      };

    case NOTIFICATION_EVENTS.DAILY_DIGEST:
      return {
        data: {
          date: today(),
          sections: [
            {
              title: 'Tasks due today',
              items: [
                { label: '[SAMPLE] Send the spares quote to John at Trendsetter', link: '/activities' },
                { label: '[SAMPLE] Follow up with Acme on the integration question', link: '/activities' },
              ],
            },
            {
              title: 'Opportunities moved this week',
              items: [
                { label: '[SAMPLE] 12345 · Spares for pump skid (Lead → Quote sent)', link: '/opportunities' },
              ],
            },
          ],
        },
        context: {},
      };

    default:
      return { data: { message: 'Sample notification for ' + eventType }, context: {} };
  }
}

function tomorrow() {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}
function today() {
  return new Date().toISOString().slice(0, 10);
}
