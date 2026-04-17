// workers/cron/src/index.js
//
// C-LARS PMS sidecar cron Worker.
//
// Two entry points:
//
//   scheduled(event, env, ctx)
//     Fired by the cron trigger defined in wrangler.jsonc. Hits the
//     Pages site's /api/cron/sweep endpoint with the shared secret.
//     Logs the response for observability via `wrangler tail`.
//
//   fetch(request, env, ctx)
//     Tiny HTTP surface. Lets an operator kick a sweep manually
//     without waiting for the cron tick — useful during development
//     and after deploying a new sweep.
//       GET  /           → health check (no auth)
//       POST /__run      → manual sweep; requires x-cron-secret header
//
// Cloudflare's Access sits in front of pms.c-lars.com, so the Worker
// can't auth via a login flow. Instead it passes the pre-shared
// CRON_SECRET on every request. The Pages endpoint validates the same
// value, constant-time.
//
// Errors from the Pages endpoint do NOT retry here — a repeated sweep
// the next day picks up anything that was missed, and the cron_runs
// dedup guarantees no double-fires on retry. If a run fails we log
// and move on.

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSweep(env).catch((err) => {
      console.error('cron scheduled run failed:', err?.message || err);
    }));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return jsonResponse({
        ok: true,
        name: 'c-lars-pms-cron',
        message: 'Sidecar cron Worker. POST /__run with x-cron-secret to fire a sweep.',
      });
    }

    if (request.method === 'POST' && url.pathname === '/__run') {
      const provided = request.headers.get('x-cron-secret') || '';
      if (!secretsMatch(provided, env.CRON_SECRET || '')) {
        return new Response('Unauthorized', { status: 401 });
      }
      const result = await runSweep(env);
      return jsonResponse(result, result.ok ? 200 : 502);
    }

    return new Response('Not found', { status: 404 });
  },
};

async function runSweep(env) {
  const pmsUrl = (env.PMS_URL || '').replace(/\/$/, '');
  if (!pmsUrl) {
    const msg = 'PMS_URL is not configured — refusing to sweep.';
    console.error(msg);
    return { ok: false, error: msg };
  }
  if (!env.CRON_SECRET) {
    const msg = 'CRON_SECRET is not configured on this Worker — refusing to sweep.';
    console.error(msg);
    return { ok: false, error: msg };
  }

  const target = `${pmsUrl}/api/cron/sweep`;
  const startedAt = new Date().toISOString();

  let res;
  try {
    res = await fetch(target, {
      method: 'POST',
      headers: {
        'x-cron-secret': env.CRON_SECRET,
        'user-agent': 'c-lars-pms-cron/1.0',
      },
    });
  } catch (err) {
    console.error('cron fetch failed:', err?.message || err);
    return { ok: false, target, startedAt, error: err?.message || String(err) };
  }

  // Read once as text, then try to parse — res.body can only be consumed
  // one time, so fetch-then-fallback would throw "Body has already been used".
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }

  // Log a compact summary to `wrangler tail` so it's easy to confirm
  // the sweep fired and see the per-trigger counts at a glance.
  console.log(JSON.stringify({
    cron: 'c-lars-pms-cron',
    startedAt,
    target,
    status: res.status,
    body,
  }));

  return { ok: res.ok, status: res.status, target, startedAt, body };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

// Constant-time string compare. Mirrors the Pages endpoint's check so
// the two sides agree on what counts as a match.
function secretsMatch(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
