// functions/activities/[id]/ics.js
//
// GET /activities/:id/ics — download a one-event .ics for this activity.
//
// Treats every activity type (task / note / email / call / meeting) as
// a VEVENT with a 30-minute duration starting at due_at. VTODO is
// poorly supported by Google Calendar, so a uniform VEVENT view gives
// the cleanest cross-client experience.

import { one } from '../../lib/db.js';
import { buildIcsCalendar } from '../../lib/ics.js';

export async function onRequestGet(context) {
  const { env, data, params } = context;
  const user = data?.user;
  if (!user) return new Response('Sign in required', { status: 401 });

  const act = await one(env.DB,
    `SELECT a.id, a.subject, a.body, a.type, a.due_at,
            o.number AS opp_number, o.title AS opp_title,
            u.display_name AS assigned_name, u.email AS assigned_email
       FROM activities a
       LEFT JOIN opportunities o ON o.id = a.opportunity_id
       LEFT JOIN users u ON u.id = a.assigned_user_id
      WHERE a.id = ?`,
    [params.id]);

  if (!act) return new Response('Activity not found', { status: 404 });
  if (!act.due_at) {
    return new Response('Activity has no due date — cannot generate calendar event.', {
      status: 400,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const summary = act.subject || `(no subject — ${act.type || 'activity'})`;

  const descLines = [];
  if (act.body) descLines.push(act.body);
  if (act.opp_number) descLines.push(`Opportunity: ${act.opp_number}${act.opp_title ? ' — ' + act.opp_title : ''}`);
  if (act.assigned_name || act.assigned_email) {
    descLines.push(`Assigned to: ${act.assigned_name || act.assigned_email}`);
  }
  const description = descLines.join('\n\n') || null;

  const ics = buildIcsCalendar({
    events: [{
      uid: `activity-${act.id}@c-lars.com`,
      summary,
      description,
      start: act.due_at,
      durationMins: 30,
      organizer: act.assigned_email || null,
    }],
  });

  return new Response(ics, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="activity-${act.id}.ics"`,
      'Cache-Control': 'no-store',
    },
  });
}
