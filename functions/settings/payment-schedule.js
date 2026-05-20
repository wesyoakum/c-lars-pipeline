// functions/settings/payment-schedule.js
//
// POST /settings/payment-schedule — save a payment schedule for a quote type.
// Accepts { quote_type, schedule: { rows: [{ percent, label }] } }.

import { hasRole } from '../lib/auth.js';
import { saveSchedule, SCHEDULE_TYPES } from '../lib/payment-schedules.js';

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user || !hasRole(user, 'admin')) {
    return json({ ok: false, error: 'Admin only' }, 403);
  }

  let body;
  try { body = await request.json(); } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const { quote_type, schedule } = body;
  if (!quote_type || !SCHEDULE_TYPES.includes(quote_type)) {
    return json({ ok: false, error: `Invalid quote type: ${quote_type}` }, 400);
  }

  try {
    await saveSchedule(env, quote_type, schedule, user);
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: e.message || String(e) }, 400);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
