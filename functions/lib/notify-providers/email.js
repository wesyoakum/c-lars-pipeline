// functions/lib/notify-providers/email.js
//
// Email provider for the external-notifications dispatcher (Phase 7c).
// Uses Resend (https://resend.com) — REST API, transactional, free
// tier handles 3000 emails/mo. Self-registers into the dispatcher's
// PROVIDERS map at module load.
//
// Environment variables (Cloudflare Pages secrets):
//   RESEND_API_KEY      — required. Get one at https://resend.com/api-keys
//   NOTIFICATION_FROM   — optional. "From" address in RFC 5322 form, e.g.
//                         'C-LARS PMS <pms@notifications.example.com>'.
//                         Defaults to 'C-LARS PMS <onboarding@resend.dev>'
//                         which is Resend's sandbox sender (only delivers
//                         to email addresses on your Resend account —
//                         fine for solo dev/testing).
//
// When you verify a real sending domain later, just update
// NOTIFICATION_FROM. No code change.

import { registerNotificationProvider } from '../notify-external.js';
import { renderEmailMessage } from './email-templates.js';

const DEFAULT_FROM = 'C-LARS PMS <onboarding@resend.dev>';

async function send(env, opts) {
  const apiKey = env?.RESEND_API_KEY;
  if (!apiKey) {
    return { status: 'failed', error: 'missing_RESEND_API_KEY' };
  }

  const target = String(opts?.target || '').trim();
  if (!target || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) {
    return { status: 'failed', error: 'invalid_email_target' };
  }

  let message;
  try {
    message = renderEmailMessage(opts.eventType, opts.data || {}, opts.context || {});
  } catch (e) {
    return { status: 'failed', error: 'template_render_failed: ' + (e?.message || e) };
  }

  const from = (env.NOTIFICATION_FROM && String(env.NOTIFICATION_FROM).trim()) || DEFAULT_FROM;

  const body = {
    from,
    to: [target],
    subject: message.subject,
    html: message.html,
    text: message.text,
  };

  let res;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { status: 'failed', error: 'fetch_failed: ' + (e?.message || e) };
  }

  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch (_) { /* ignore */ }
    return {
      status: 'failed',
      error: 'http_' + res.status + (detail ? ': ' + detail.slice(0, 200) : ''),
      payload_preview: '[' + message.subject + '] to ' + target,
    };
  }

  return {
    status: 'sent',
    payload_preview: '[' + message.subject + '] to ' + target,
  };
}

registerNotificationProvider('email', { send });
