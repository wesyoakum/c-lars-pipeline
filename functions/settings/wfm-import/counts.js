// functions/settings/wfm-import/counts.js
//
// GET /settings/wfm-import/counts
//
// Lightweight WFM health-check: returns per-kind record counts
// (clients / leads / quotes / jobs / invoices / staff) by hitting
// the BlueRock API directly. Uses the API's TotalRecords hint where
// available, falls back to a single full-list fetch otherwise.
//
// Used by:
//   - The counts strip at the top of /settings/wfm-import (page calls
//     this on load + when Refresh is clicked).
//   - Anyone curling for a quick "is WFM reachable + what's there?"
//     check.
//
// Admin only. Reuses the same wfmCount() helper Claudia uses via the
// wfm_count chat tool, so the numbers are guaranteed identical.

import { hasRole } from '../../lib/auth.js';
import { wfmCount } from '../../sandbox/assistant/wfm-tools.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestGet(context) {
  const { env, data } = context;
  const user = data?.user;
  if (!user) return json({ ok: false, error: 'sign_in_required' }, 401);
  if (!hasRole(user, 'admin')) return json({ ok: false, error: 'admin_only' }, 403);
  const result = await wfmCount(env);
  return json({ ok: true, ...result });
}
