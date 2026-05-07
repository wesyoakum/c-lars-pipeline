// workers/claudia-consumer/src/index.js
//
// C-LARS Pipeline sidecar consumer Worker for the cf-claudia-events
// queue.
//
// Two entry points:
//
//   queue(batch, env, ctx)
//     Fired by the queue subscription defined in wrangler.jsonc. Each
//     message body comes from queueClaudiaEvent() in the Pages project
//     ({ event_id, type, ref_id, summary, user_id, sent_at }). For each
//     message, POST to the Pages site at /api/claudia/event-tick. The
//     Pages endpoint loads the event by id, runs enrichment + the
//     action extractor, and writes claudia_actions / claudia_questions
//     / claudia_observations rows. Then we ack on success or retry on
//     5xx / network error.
//
//   fetch(request, env, ctx)
//     Tiny HTTP surface for manual triggers + health checks.
//       GET  /         → health check
//       POST /__run    → manually fire one event by event_id (in body)
//
// Cloudflare Access sits in front of the Pages site, so the Worker
// can't auth via SSO. Same pattern as workers/cron/ — pass CRON_SECRET
// + optional CF Access service-token headers.

export default {
  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      try {
        await processOneMessage(env, message);
      } catch (err) {
        console.error('[claudia-consumer] message handling threw:', err?.message || err);
        // Defensive — handler should already have called retry()/ack();
        // if it threw, bias toward retry.
        try { message.retry({ delaySeconds: 30 }); } catch { /* already settled */ }
      }
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return jsonResponse({
        ok: true,
        name: 'c-lars-pms-claudia-consumer',
        message: 'Sidecar consumer Worker for cf-claudia-events. POST /__run with x-cron-secret to fire one event manually.',
      });
    }

    if (request.method === 'POST' && url.pathname === '/__run') {
      const provided = request.headers.get('x-cron-secret') || '';
      if (!secretsMatch(provided, env.CRON_SECRET || '')) {
        return new Response('Unauthorized', { status: 401 });
      }
      let body;
      try { body = await request.json(); } catch {
        return jsonResponse({ ok: false, error: 'invalid_json' }, 400);
      }
      if (!body?.event_id) {
        return jsonResponse({ ok: false, error: 'event_id_required' }, 400);
      }
      const result = await callEventTick(env, body, '__run');
      return jsonResponse(result, result.ok ? 200 : 502);
    }

    return new Response('Not found', { status: 404 });
  },
};

/**
 * Forward one queue message to the Pages event-tick endpoint and
 * settle the queue message based on the response.
 *
 * Settlement policy:
 *   2xx          → ack (no retry)
 *   4xx          → ack (logic error; retrying won't help)
 *   5xx / network → retry (transient — Pages restart, D1 hiccup, etc.)
 */
async function processOneMessage(env, message) {
  const body = message.body || {};
  const result = await callEventTick(env, body, 'queue');

  if (result.status >= 200 && result.status < 300) {
    message.ack();
    return;
  }
  if (result.status >= 400 && result.status < 500) {
    // Logic error: malformed payload, missing event row, etc. Don't
    // burn retry attempts on something that won't change.
    console.warn('[claudia-consumer] 4xx from event-tick — acking:', result);
    message.ack();
    return;
  }
  // 5xx or network: retry. Cloudflare Queues handles backoff; we just
  // pass a small base delay so retries don't immediately stampede.
  console.warn('[claudia-consumer] retrying after non-2xx/4xx:', result);
  message.retry({ delaySeconds: 30 });
}

/**
 * POST one event payload to /api/claudia/event-tick on the Pages site.
 * Returns { ok, status, target, body } so the caller can settle the
 * queue message accordingly.
 */
async function callEventTick(env, body, label) {
  const pipelineUrl = (env.PIPELINE_URL || '').replace(/\/$/, '');
  if (!pipelineUrl) {
    const msg = 'PIPELINE_URL is not configured — refusing to call.';
    console.error(msg);
    return { ok: false, status: 0, error: msg };
  }
  if (!env.CRON_SECRET) {
    const msg = 'CRON_SECRET is not configured on this Worker — refusing to call.';
    console.error(msg);
    return { ok: false, status: 0, error: msg };
  }

  const target = `${pipelineUrl}/api/claudia/event-tick`;
  const startedAt = new Date().toISOString();

  const headers = {
    'x-cron-secret': env.CRON_SECRET,
    'content-type': 'application/json; charset=utf-8',
    'user-agent': 'c-lars-pms-claudia-consumer/1.0',
  };
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    headers['CF-Access-Client-Id']     = env.CF_ACCESS_CLIENT_ID;
    headers['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET;
  }

  let res;
  try {
    res = await fetch(target, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(label + ' fetch failed:', err?.message || err);
    return { ok: false, status: 0, target, startedAt, error: err?.message || String(err) };
  }

  const text = await res.text();
  let respBody;
  try { respBody = JSON.parse(text); } catch { respBody = { raw: text }; }

  console.log(JSON.stringify({
    consumer: 'c-lars-pms-claudia-consumer',
    label,
    startedAt,
    target,
    status: res.status,
    event_id: body?.event_id ?? null,
    type: body?.type ?? null,
    body: respBody,
  }));

  return { ok: res.ok, status: res.status, target, startedAt, body: respBody };
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

function secretsMatch(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
