// functions/ai-inbox/[id]/audio.js
//
// GET /ai-inbox/:id/audio
//
// Stream the audio file from R2. We re-check ownership against the
// AI Inbox row before serving — even though the bucket itself isn't
// public, this also enforces "you can only play your own audio."

import { one } from '../../lib/db.js';
import { streamFromR2 } from '../../lib/r2.js';

export async function onRequestGet(context) {
  const { env, data, params } = context;
  const user = data?.user;

  const item = await one(
    env.DB,
    'SELECT audio_r2_key, audio_mime_type FROM ai_inbox_items WHERE id = ? AND user_id = ?',
    [params.id, user.id]
  );

  if (!item || !item.audio_r2_key) {
    return new Response('Not found', { status: 404 });
  }

  const resp = await streamFromR2(env.DOCS, item.audio_r2_key);
  if (resp.status !== 200) return resp;

  // Override Content-Type if R2 didn't set one — browsers need it for <audio>.
  const headers = new Headers(resp.headers);
  if (!headers.get('content-type') && item.audio_mime_type) {
    headers.set('content-type', item.audio_mime_type);
  }
  return new Response(resp.body, { headers });
}
