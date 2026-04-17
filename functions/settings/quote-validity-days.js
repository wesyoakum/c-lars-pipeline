// functions/settings/quote-validity-days.js
//
// POST /settings/quote-validity-days
//   Body JSON: { quote_type: <string>, days: <positive int> }
//
// Admin-only. Upserts the per-quote-type `validity_days` row in the
// `quote_term_defaults` table (migration 0024 + migration 0038 seed).
// Returns { ok: true, days: <int> } on success.
//
// The value is stored as text in the shared defaults table — we parse
// and re-stringify so a bad client can't poison the column with a
// non-integer.

import { setQuoteTermDefault, VALIDITY_DAYS_TYPES } from '../lib/quote-term-defaults.js';
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

  const quoteType = String(body?.quote_type || '').trim();
  if (!VALIDITY_DAYS_TYPES.includes(quoteType)) {
    return jsonErr('Unknown quote type.', 400);
  }

  const days = parseInt(body?.days, 10);
  if (!Number.isFinite(days) || days <= 0 || days > 3650) {
    return jsonErr('Days must be a positive integer (max 3650).', 400);
  }

  await setQuoteTermDefault(env, quoteType, 'validity_days', String(days), user);

  return new Response(JSON.stringify({ ok: true, days }), {
    headers: { 'content-type': 'application/json' },
  });
}

function jsonErr(error, status) {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
