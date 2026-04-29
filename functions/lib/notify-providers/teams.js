// functions/lib/notify-providers/teams.js
//
// Microsoft Teams provider for the external-notifications dispatcher
// (Phase 7b). Posts an Adaptive Card to a user-configured incoming-
// webhook URL. The webhook URL is created in Teams (channel
// connector settings) — no Azure AD app registration needed,
// no per-tenant admin consent.
//
// The provider exports a `send(env, opts)` that the dispatcher
// (notify-external.js) calls. We register ourselves at module load
// so the dispatcher's PROVIDERS map gets populated automatically.
//
// Adaptive Card schema reference:
//   https://adaptivecards.io/explorer/AdaptiveCard.html
// Teams webhook docs:
//   https://learn.microsoft.com/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook
//
// The dispatcher (notify-external.js) imports the default export of
// this module and inserts it into PROVIDERS at its own init time.
// We deliberately do NOT call registerNotificationProvider here —
// circular imports with ESM mean the dispatcher's `const PROVIDERS`
// is still in TDZ when this module evaluates, so any auto-registration
// would silently fail.

import { renderTeamsCard } from './teams-templates.js';

export async function send(env, opts) {
  const url = String(opts?.target || '').trim();
  if (!url || !/^https:\/\//i.test(url)) {
    return { status: 'failed', error: 'invalid_webhook_url' };
  }

  // Render the Adaptive Card payload from the per-event template.
  let payload;
  try {
    payload = renderTeamsCard(opts.eventType, opts.data || {}, opts.context || {});
  } catch (e) {
    return { status: 'failed', error: 'template_render_failed: ' + (e?.message || e) };
  }

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return { status: 'failed', error: 'fetch_failed: ' + (e?.message || e) };
  }

  // Teams webhooks return:
  //   - 200 with body "1" on success (legacy O365 connectors)
  //   - 202 with empty body on success (newer Teams webhooks)
  //   - 4xx with a JSON error on rejection
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch (_) { /* ignore */ }
    return {
      status: 'failed',
      error: 'http_' + res.status + (detail ? ': ' + detail.slice(0, 200) : ''),
      payload_preview: JSON.stringify(payload),
    };
  }

  return {
    status: 'sent',
    payload_preview: JSON.stringify(payload),
  };
}

export default { send };
