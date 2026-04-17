// functions/_middleware.js
//
// Runs on every request into Pages Functions. Responsibilities:
//   1. Let static assets (CSS/JS/images) through untouched.
//   2. Resolve the current user from Cloudflare Access headers (or
//      fall back to a dev stub when PMS_ENV !== 'production').
//   3. Attach the resolved user to context.data so downstream handlers
//      can do `context.data.user`.
//   4. In production: return 401 if no Access identity was found.
//
// Auth model: Cloudflare Access sits in front of pms.c-lars.com and
// authenticates the user via Google/Microsoft SSO against @c-lars.com.
// It then proxies the request to the Pages app with
// Cf-Access-Authenticated-User-Email set. We trust that header because
// Access is the only path in — there is no other way to reach these
// Functions from the public internet.

import { resolveUser } from './lib/auth.js';
import { unauthorizedResponse } from './lib/layout.js';

// Paths that bypass SSO auth entirely.
//   - Static assets served from /public (no auth needed).
//   - /api/cron/ endpoints — the sidecar cron Worker can't authenticate
//     via Access (no interactive login), so those endpoints enforce
//     their own constant-time CRON_SECRET header check. See
//     functions/api/cron/sweep.js.
const PUBLIC_PREFIXES = ['/css/', '/js/', '/img/', '/favicon.ico', '/api/cron/'];

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // Static assets: pass-through.
  if (PUBLIC_PREFIXES.some((p) => url.pathname === p || url.pathname.startsWith(p))) {
    return next();
  }

  // Resolve user (reads Cf-Access-Authenticated-User-Email header in prod).
  const user = await resolveUser(request, env);

  if (!user) {
    // Production + no Access header ⇒ block.
    return unauthorizedResponse();
  }

  // Make user available to downstream route handlers.
  context.data = context.data ?? {};
  context.data.user = user;
  context.data.env = env.PMS_ENV ?? 'production';

  return next();
}
