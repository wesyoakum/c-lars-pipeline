// functions/ai-inbox/[id]/delete.js
//
// POST /ai-inbox/:id/delete
//
// Delete an item: removes the row and the corresponding R2 audio
// object (best-effort). We intentionally do hard deletes rather than
// soft so the feature stays cleanly revertable — no graveyard rows.

import { one, run } from '../../lib/db.js';
import { deleteFromR2 } from '../../lib/r2.js';
import { redirectWithFlash } from '../../lib/http.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;

  const item = await one(
    env.DB,
    'SELECT id, audio_r2_key FROM ai_inbox_items WHERE id = ? AND user_id = ?',
    [params.id, user.id]
  );
  if (!item) {
    return redirectWithFlash('/ai-inbox', 'Item not found.', 'error');
  }

  if (item.audio_r2_key) {
    try { await deleteFromR2(env.DOCS, item.audio_r2_key); } catch { /* swallow */ }
  }

  await run(env.DB, 'DELETE FROM ai_inbox_items WHERE id = ?', [params.id]);

  return redirectWithFlash('/ai-inbox', 'Deleted.', 'success');
}
