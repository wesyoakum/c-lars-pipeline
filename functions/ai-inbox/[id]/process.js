// functions/ai-inbox/[id]/process.js
//
// POST /ai-inbox/:id/process
//
// Manual re-run of the pipeline (transcribe → classify → extract). Used
// by the "Re-run pipeline" button on the detail page when the original
// run failed or the user wants to redo extraction. Always restarts at
// the transcribe step for simplicity in Phase 1.

import { one } from '../../lib/db.js';
import { redirect, redirectWithFlash } from '../../lib/http.js';
import { processItem } from '../process-helpers.js';

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;

  const item = await one(
    env.DB,
    'SELECT id FROM ai_inbox_items WHERE id = ? AND user_id = ?',
    [params.id, user.id]
  );
  if (!item) {
    return redirectWithFlash('/ai-inbox', 'Item not found.', 'error');
  }

  try {
    await processItem(env, params.id, 'transcribe');
  } catch (e) {
    // processItem already wrote 'error' status + message; redirect to
    // the detail page so the user can see what failed.
  }

  return redirect(`/ai-inbox/${params.id}`);
}
