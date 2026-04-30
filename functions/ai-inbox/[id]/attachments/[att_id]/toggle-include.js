// functions/ai-inbox/[id]/attachments/[att_id]/toggle-include.js
//
// POST /ai-inbox/:id/attachments/:att_id/toggle-include
//
// Flips include_in_context (0 ⇄ 1). Excluded attachments stay on the
// entry — their captured_text is still readable in the panel — but
// compileContext() skips them when building the LLM input. Useful for
// silencing a noisy or off-topic attachment without losing it.
//
// Re-extraction is NOT triggered automatically; the user runs it
// manually when they want the curation to take effect.

import { one, run } from '../../../../lib/db.js';
import { now } from '../../../../lib/ids.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestPost(context) {
  const { env, data, params } = context;
  const user = data?.user;

  const att = await one(env.DB,
    `SELECT a.id, a.include_in_context
       FROM ai_inbox_attachments a
       JOIN ai_inbox_items i ON i.id = a.entry_id
      WHERE a.id = ? AND a.entry_id = ? AND i.user_id = ?`,
    [params.att_id, params.id, user.id]);
  if (!att) return json({ ok: false, error: 'not_found' }, 404);

  const next = att.include_in_context === 1 ? 0 : 1;
  await run(env.DB,
    'UPDATE ai_inbox_attachments SET include_in_context = ?, updated_at = ? WHERE id = ?',
    [next, now(), params.att_id]);

  return json({ ok: true, include_in_context: next });
}
