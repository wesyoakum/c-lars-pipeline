// functions/settings/wfm-import/full/run-step.js
//
// POST /settings/wfm-import/full/run-step
//
// Manual trigger for one chunk of full-import processing. Identical
// work to the cron-driven /api/cron/wfm-step, but protected by the
// site's normal SSO+admin auth instead of the CRON_SECRET header.
//
// Why this exists: Cloudflare Access sits in front of the Pages app,
// and the sidecar cron Worker can't authenticate via SSO. The
// proper fix is an Access bypass policy or service-token policy on
// /api/cron/* — but that requires the user's Cloudflare role to
// include "edit Access apps", which our user doesn't have access to
// adjust right now. This endpoint sidesteps that: the admin user is
// already through Access for the rest of the workbench, so they can
// drain the queue manually with one click per chunk.
//
// Each call processes ~25s worth of records (same TICK_BUDGET_MS as
// the cron path) and returns the progress. The workbench UI calls
// this in a loop until the run completes.

import { hasRole } from '../../../lib/auth.js';
import { runOneStep } from '../../../api/cron/wfm-step.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestPost(context) {
  const { env, data } = context;
  const user = data?.user;
  if (!user) return json({ ok: false, error: 'sign_in_required' }, 401);
  if (!hasRole(user, 'admin')) return json({ ok: false, error: 'admin_only' }, 403);

  return runOneStep(env);
}
