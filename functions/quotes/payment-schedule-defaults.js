// functions/quotes/payment-schedule-defaults.js
//
// POST /quotes/payment-schedule-defaults
//
// Admin-only. Saves the given schedule as the default for the given
// quote_type. The per-quote schedule editor's "Set as default" button
// posts here.
//
// Body: { quote_type: 'eps' | 'spares' | 'service' | 'refurb_*',
//         schedule: { rows: [...] } }
//
// The schedule is normalized + validated via the same path the
// per-quote save uses, so a bad schedule can't poison the type
// default.

import { hasRole } from '../lib/auth.js';
import { saveDefaultScheduleForType } from '../lib/quote-payment-schedule.js';

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user) return jsonError(401, 'sign-in required');
  if (!hasRole(user, 'admin')) return jsonError(403, 'admin only');

  let body;
  try { body = await request.json(); }
  catch { return jsonError(400, 'invalid JSON body'); }

  const quoteType = String(body?.quote_type || '').trim();
  if (!quoteType) return jsonError(400, 'quote_type is required');

  try {
    const normalized = await saveDefaultScheduleForType(env, quoteType, body?.schedule, user);
    return new Response(JSON.stringify({
      ok: true,
      quote_type: quoteType,
      schedule: normalized,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  } catch (err) {
    return jsonError(400, String(err && err.message || err));
  }
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
