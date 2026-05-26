// functions/settings/activity/poll.js
//
// GET /settings/activity/poll?after=<iso> — returns new audit events since
// the given timestamp. Used by the timeline tab's live-update polling.
// Admin-only. Returns JSON array of event objects.

import { all } from '../../lib/db.js';
import { hasRole } from '../../lib/auth.js';

export async function onRequestGet(context) {
  const { env, data, request } = context;
  const user = data?.user;

  if (!hasRole(user, 'admin')) {
    return json({ ok: false, error: 'forbidden' }, 403);
  }

  const url = new URL(request.url);
  const after = url.searchParams.get('after') || '';

  if (!after) {
    return json({ ok: true, events: [] });
  }

  const events = await all(env.DB,
    `SELECT ae.id, ae.entity_type, ae.entity_id, ae.event_type, ae.at,
            ae.summary, ae.user_id,
            u.display_name AS user_name, u.email AS user_email
       FROM audit_events ae
       LEFT JOIN users u ON u.id = ae.user_id
      WHERE ae.at > ?
      ORDER BY ae.at DESC
      LIMIT 50`,
    [after]
  );

  return json({ ok: true, events });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
