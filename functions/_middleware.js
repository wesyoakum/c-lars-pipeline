// functions/_middleware.js
//
// Runs on every request into Pages Functions. Responsibilities:
//   1. Let static assets (CSS/JS/images) through untouched.
//   2. Resolve the current user from Cloudflare Access headers (or
//      fall back to a dev stub when PIPELINE_ENV !== 'production').
//   3. Attach the resolved user to context.data so downstream handlers
//      can do `context.data.user`.
//   4. In production: return 401 if no Access identity was found.
//
// Auth model: Cloudflare Access sits in front of __KEEP_PipelineDOMAIN__ and
// authenticates the user via Google/Microsoft SSO against @c-lars.com.
// It then proxies the request to the Pages app with
// Cf-Access-Authenticated-User-Email set. We trust that header because
// Access is the only path in — there is no other way to reach these
// Functions from the public internet.

import { resolveUser } from './lib/auth.js';
import { unauthorizedResponse } from './lib/layout.js';
import { audit } from './lib/audit.js';

// Paths that bypass SSO auth entirely.
//   - Static assets served from /public (no auth needed).
//   - /api/cron/ endpoints — the sidecar cron Worker can't authenticate
//     via Access (no interactive login), so those endpoints enforce
//     their own constant-time CRON_SECRET header check. See
//     functions/api/cron/sweep.js.
//   - /api/email-ingest — the Outlook add-in's iframe has no Access
//     cookie. Endpoint enforces its own OUTLOOK_ADDIN_SECRET bearer
//     check + WES_KNOWN_EMAILS recipient allowlist. See
//     functions/api/email-ingest.js.
//   - /outlook-addin/ — manifest, commands.html/js, taskpane.html for
//     the Outlook add-in. Public by design (the shared secret in
//     commands.js is documented in docs/outlook-addin-setup.md).
const PUBLIC_PREFIXES = ['/css/', '/js/', '/img/', '/favicon.ico', '/api/cron/', '/api/email-ingest', '/outlook-addin/'];

// Derive a human-readable page title from a URL pathname.
function pageTitle(pathname) {
  const p = pathname.replace(/\/$/, '') || '/';
  if (p === '/') return 'Dashboard';
  // Static top-level pages
  const TOP = {
    '/opportunities': 'Opportunities',
    '/accounts': 'Accounts',
    '/accounts/contacts': 'Contacts',
    '/library': 'Items Library',
    '/documents/library': 'Document Library',
    '/notifications': 'Notifications',
    '/ai-inbox': 'AI Inbox',
    '/settings': 'Settings',
  };
  if (TOP[p]) return TOP[p];
  // Settings sub-pages
  const settingsMatch = p.match(/^\/settings\/(.+)/);
  if (settingsMatch) {
    const sub = settingsMatch[1].split('/')[0].replace(/-/g, ' ');
    return 'Settings / ' + sub.charAt(0).toUpperCase() + sub.slice(1);
  }
  // Entity detail pages — pattern match on UUID segments
  const segments = p.split('/').filter(Boolean);
  if (segments[0] === 'opportunities' && segments.length >= 2) {
    if (segments.length >= 4 && segments[2] === 'quotes') return 'Quote Detail';
    return 'Opportunity Detail';
  }
  if (segments[0] === 'accounts' && segments.length >= 2) return 'Account Detail';
  if (segments[0] === 'contacts' && segments.length >= 2) return 'Contact Detail';
  // Fallback: capitalize first segment
  return segments[0].charAt(0).toUpperCase() + segments[0].slice(1).replace(/-/g, ' ');
}

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
  context.data.env = env.PIPELINE_ENV ?? 'production';

  // Fire-and-forget page-view tracking for admin activity log.
  // Only log HTML page views (skip API/JSON/asset requests).
  const accept = request.headers.get('accept') || '';
  if (accept.includes('text/html') && env.DB && user.id) {
    context.waitUntil(
      (async () => {
        // Synthetic session detection: if last_seen_at is >30 min ago (or null),
        // treat this as a new session and write an audit event.
        try {
          const row = await env.DB.prepare(
            `SELECT last_seen_at FROM users WHERE id = ?`
          ).bind(user.id).first();
          const lastSeen = row?.last_seen_at ? new Date(row.last_seen_at + 'Z').getTime() : 0;
          const gap = Date.now() - lastSeen;
          if (!lastSeen || gap > 30 * 60 * 1000) {
            await audit(env.DB, {
              entityType: 'user',
              entityId: user.id,
              eventType: 'session_started',
              user,
              summary: `Session started (${url.pathname})`,
            });
          }
        } catch (_) { /* best-effort */ }

        await env.DB.prepare(
          `INSERT INTO user_page_views (user_id, url, at) VALUES (?, ?, datetime('now'))`
        ).bind(user.id, url.pathname).run();
        await env.DB.prepare(`UPDATE users SET last_seen_at = datetime('now') WHERE id = ?`)
          .bind(user.id).run();

        // Log every page view as an audit event so it shows on the activity timeline.
        await audit(env.DB, {
          entityType: 'page',
          entityId: user.id,
          eventType: 'viewed',
          user,
          summary: pageTitle(url.pathname),
          changes: { path: url.pathname },
        });
      })().catch(() => {/* ignore — table may not exist yet */})
    );
  }

  return next();
}
