// functions/api/cron/sweep.js
//
// POST /api/cron/sweep — trigger all scheduled auto-task sweeps.
//
// Cloudflare Pages Functions don't support cron triggers natively, so
// this endpoint is hit by a sidecar Cloudflare Worker (see workers/cron/)
// whose `scheduled` handler runs on a cron schedule and forwards to us.
//
// Authentication:
//   The request MUST carry an `x-cron-secret` header matching env.CRON_SECRET.
//   Set the secret with:
//     wrangler pages secret put CRON_SECRET
//   The same value goes into the sidecar Worker so the two can handshake.
//
//   We intentionally skip Cloudflare Access on this route by prefixing
//   with /api/ — Access is scoped to the app UI. A shared secret is the
//   right primitive here (Access only accepts interactive logins).
//
// Idempotence:
//   Each sweep uses cron_runs (sweep_key, window_start) to dedupe per
//   UTC-day bucket. Calling this endpoint twice in the same day is a
//   no-op for the second call. See functions/lib/cron-sweeps.js.
//
// Response:
//   200 JSON { ok: true, results: {<sweep_key>: {bucket, fired, skipped, ...}} }
//   401 if the secret is missing/wrong
//   500 JSON { ok: false, error } if an individual sweep throws (the
//       other sweeps still run — per-sweep errors are returned in results).

import { runAllSweeps } from '../../lib/cron-sweeps.js';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function unauthorized(msg = 'Unauthorized') {
  return new Response(msg, { status: 401 });
}

function checkSecret(request, env) {
  const provided = request.headers.get('x-cron-secret') || '';
  const expected = env.CRON_SECRET || '';
  if (!expected) {
    // Fail-closed: if the secret isn't configured on this deployment,
    // refuse all cron calls. Avoid running sweeps unguarded.
    return false;
  }
  if (provided.length !== expected.length) return false;
  // Constant-time compare — don't short-circuit on first mismatch.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

export async function onRequestPost(context) {
  const { env, request } = context;

  if (!checkSecret(request, env)) {
    return unauthorized();
  }

  try {
    const results = await runAllSweeps(env);
    return jsonResponse({ ok: true, at: new Date().toISOString(), results });
  } catch (err) {
    console.error('cron sweep failed:', err?.message || err);
    return jsonResponse(
      { ok: false, error: err?.message || String(err) },
      500
    );
  }
}

// Allow GET for manual smoke-testing + health checks. Still requires the
// secret header so it can't be used to kick off sweeps without auth.
export async function onRequestGet(context) {
  const { env, request } = context;
  if (!checkSecret(request, env)) return unauthorized();
  return jsonResponse({
    ok: true,
    message: 'Cron endpoint healthy. POST here to run sweeps.',
    at: new Date().toISOString(),
  });
}
