// functions/ai-inbox/[id]/delete.js
//
// POST /ai-inbox/:id/delete — delete an AI Inbox entry and all its
// attachments + R2 files + link rows + match rows.
//
// Hard delete (not soft). FK CASCADE on ai_inbox_items handles
// ai_inbox_attachments / ai_inbox_links / ai_inbox_entity_matches
// rows automatically (per migrations 0048 / 0051 / 0052). The DB
// cascades, but the R2 attachments don't — we walk the attachment
// rows for r2_key values and delete each before the parent row.
//
// Also deletes the legacy audio_r2_key on the entry itself (v1/v2
// entries that pre-date the attachments table still hold the file
// reference there in addition to / instead of the attachments
// table).
//
// Auth: ownership check via user_id on the entry row.

import { one, all, stmt, batch } from '../../lib/db.js';
import { auditStmt } from '../../lib/audit.js';
import { deleteFromR2 } from '../../lib/r2.js';
import { redirectWithFlash } from '../../lib/http.js';

function wantsJson(request) {
  const a = request.headers.get('accept') || '';
  return a.includes('application/json') && !a.includes('text/html');
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function onRequestPost(context) {
  const { env, data, request, params } = context;
  const user = data?.user;
  const entryId = params.id;
  const json = wantsJson(request);

  if (!user) {
    if (json) return jsonResponse({ ok: false, error: 'unauthenticated' }, 401);
    return redirectWithFlash('/ai-inbox', 'Sign in required.', 'error');
  }

  const entry = await one(env.DB,
    'SELECT id, user_id, audio_r2_key FROM ai_inbox_items WHERE id = ?',
    [entryId]);
  if (!entry) {
    if (json) return jsonResponse({ ok: false, error: 'not_found' }, 404);
    return redirectWithFlash('/ai-inbox', 'Entry not found.', 'error');
  }
  if (entry.user_id !== user.id) {
    if (json) return jsonResponse({ ok: false, error: 'forbidden' }, 403);
    return redirectWithFlash('/ai-inbox', 'You can only delete your own entries.', 'error');
  }

  // Collect every R2 key associated with this entry. Both the v1/v2
  // legacy column and the v3 attachments table — some entries have
  // both (audio uploads still write the legacy column for backward
  // compat in the audio player on the detail page).
  const attachments = await all(env.DB,
    'SELECT id, r2_key FROM ai_inbox_attachments WHERE entry_id = ?',
    [entryId]);
  const r2Keys = new Set();
  for (const a of attachments) if (a.r2_key) r2Keys.add(a.r2_key);
  if (entry.audio_r2_key) r2Keys.add(entry.audio_r2_key);

  // Best-effort R2 cleanup. Failures here don't block the row
  // delete — orphaned R2 objects are recoverable / ignorable;
  // orphaned DB rows are worse.
  for (const key of r2Keys) {
    try {
      await deleteFromR2(env.DOCS, key);
    } catch (e) {
      /* eslint-disable-next-line no-console */
      if (typeof console !== 'undefined') {
        console.warn('R2 delete failed for', key, e?.message || e);
      }
    }
  }

  // Audit BEFORE the delete so the tombstone survives the cascade.
  await batch(env.DB, [
    auditStmt(env.DB, {
      entityType: 'ai_inbox_item',
      entityId: entryId,
      eventType: 'deleted',
      user,
      summary: 'Deleted AI Inbox entry'
        + (attachments.length > 0 ? ` (${attachments.length} attachment(s))` : ''),
    }),
    stmt(env.DB, 'DELETE FROM ai_inbox_items WHERE id = ?', [entryId]),
  ]);

  if (json) return jsonResponse({ ok: true, id: entryId });
  return redirectWithFlash('/ai-inbox', 'Entry deleted.');
}
