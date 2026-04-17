// functions/settings/eps-schedule.js
//
// POST /settings/eps-schedule
//   Body JSON: { rows: [ { percent, label, weeks_num?, weeks_den? }, ... ] }
//
// Admin-only. Validates and upserts the EPS default payment schedule
// into site_prefs.eps_schedule (migration 0040). Returns the
// normalized schedule on success so the client can replace its local
// view without an extra round-trip.

import { saveEpsSchedule } from '../lib/eps-schedule.js';
import { hasRole } from '../lib/auth.js';

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;

  if (!user) return jsonErr('Sign-in required.', 401);
  if (!hasRole(user, 'admin')) return jsonErr('Admin only.', 403);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonErr('Invalid JSON body.', 400);
  }

  try {
    const normalized = await saveEpsSchedule(env, body, user);
    return new Response(JSON.stringify({ ok: true, schedule: normalized }), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    return jsonErr(err?.message || 'Validation failed.', 400);
  }
}

function jsonErr(error, status) {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
