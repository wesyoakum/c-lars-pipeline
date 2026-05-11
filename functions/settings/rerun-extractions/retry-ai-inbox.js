// functions/settings/rerun-extractions/retry-ai-inbox.js
//
// POST /settings/rerun-extractions/retry-ai-inbox
//
// Re-runs the AI Inbox pipeline for one entry by id. Mirrors the
// existing /ai-inbox/:id/process endpoint but routes the user back to
// the admin failures list rather than the per-item detail page.

import { one } from '../../lib/db.js';
import { redirectWithFlash, formBody } from '../../lib/http.js';
import { hasRole } from '../../lib/auth.js';
import { processItem } from '../../ai-inbox/process-helpers.js';

export async function onRequestPost(context) {
  const { env, data, request } = context;
  const user = data?.user;
  if (!user || !hasRole(user, 'admin')) {
    return redirectWithFlash('/settings/rerun-extractions', 'Admin only.', 'error');
  }

  const input = await formBody(request);
  const id = String(input.id || '').trim();
  if (!id) {
    return redirectWithFlash('/settings/rerun-extractions', 'Missing id.', 'error');
  }

  const row = await one(env.DB,
    'SELECT id FROM ai_inbox_items WHERE id = ?', [id]);
  if (!row) {
    return redirectWithFlash('/settings/rerun-extractions', `Item ${id.slice(0, 8)} not found.`, 'error');
  }

  try {
    await processItem(env, id, 'attachments');
  } catch (e) {
    // processItem writes the error_message back to the row itself; the
    // flash here is just so the operator sees something happened.
    return redirectWithFlash(
      '/settings/rerun-extractions',
      `Retry failed for ${id.slice(0, 8)}: ${e?.message || 'unknown error'}`,
      'warn'
    );
  }

  return redirectWithFlash('/settings/rerun-extractions',
    `Retried ${id.slice(0, 8)}.`);
}
